import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { redis, withRedis } from "../config/redis";
import type { Interval } from "../policies/slots";
import { AppError } from "../utils/AppError";

// Temporary slot holds in Redis.
//
// When a patient (or receptionist) picks a slot, it is held for SLOT_HOLD_TTL_SECONDS while they
// confirm. Others see the slot as held and can't book it until the hold is released or expires.
//
// Data model (single-node Redis, e.g. ElastiCache with cluster mode off):
//   slot-holds:{doctorId}    sorted set, one member per hold, score = expiry (ms since epoch)
//                            member = "holdId|startMs|endMs|holderId|clinicId"
//   slot-hold:user:{userId}  "doctorId|member": the holder's current hold (one per user)
//
// Holds compare time *ranges*, not start times, so slots of different lengths can't overlap.
// Expiry uses Redis' clock (TIME), so app servers with skewed clocks agree.
//
// Holds are advisory. Postgres' exclusion constraints remain the guarantee against double
// booking, so if Redis is unavailable the booking flow still works without holds.

export interface SlotHold {
  holdId: string;
  doctorId: string;
  clinicId: string;
  startAt: Date;
  endAt: Date;
  expiresAt: Date;
}

export interface HeldInterval extends Interval {
  holderId: string;
  expiresAt: Date;
}

const doctorKey = (doctorId: string) => `slot-holds:${doctorId}`;
const holderKey = (userId: string) => `slot-hold:user:${userId}`;

// KEYS[1] doctor zset, KEYS[2] holder key
// ARGV[1] ttlMs, ARGV[2] holdId, ARGV[3] startMs, ARGV[4] endMs, ARGV[5] holderId, ARGV[6] doctorId, ARGV[7] clinicId
// Returns {1, expiresAtMs} when held, or {0, conflictingExpiresAtMs} when another user holds an overlapping slot.
const CREATE_HOLD = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
local s, e = tonumber(ARGV[3]), tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local _, ms, me, holder = string.match(m, '^([^|]+)|(%d+)|(%d+)|([^|]+)|')
  if holder ~= ARGV[5] and tonumber(ms) < e and tonumber(me) > s then
    return {0, tonumber(redis.call('ZSCORE', KEYS[1], m))}
  end
end

-- One hold per user: picking a new slot releases the previous one.
local prev = redis.call('GET', KEYS[2])
if prev then
  local sep = string.find(prev, '|', 1, true)
  redis.call('ZREM', 'slot-holds:' .. string.sub(prev, 1, sep - 1), string.sub(prev, sep + 1))
end

local member = ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5] .. '|' .. ARGV[7]
redis.call('ZADD', KEYS[1], now + ttl, member)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('SET', KEYS[2], ARGV[6] .. '|' .. member, 'PX', ttl)
return {1, now + ttl}
`;

// KEYS[1] holder key; ARGV[1] holdId ('' = whatever the user holds). Returns 1 if released.
const RELEASE_HOLD = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local sep = string.find(cur, '|', 1, true)
local member = string.sub(cur, sep + 1)
if ARGV[1] ~= '' and string.sub(member, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return 0 end
redis.call('ZREM', 'slot-holds:' .. string.sub(cur, 1, sep - 1), member)
redis.call('DEL', KEYS[1])
return 1
`;

/** Parses a hold member; exported for tests. */
export function parseMember(member: string) {
  const [holdId, startMs, endMs, holderId, clinicId] = member.split("|");
  return { holdId: holdId!, startMs: Number(startMs), endMs: Number(endMs), holderId: holderId!, clinicId: clinicId! };
}

function requireRedis() {
  const r = redis();
  if (!r) {
    throw new AppError(503, "Slot holds are unavailable right now. You can still book the slot directly.");
  }
  return r;
}

/** Holds a slot for `holderId`, replacing any hold they already have. 409 if someone else holds it. */
export async function createHold(
  holderId: string,
  doctorId: string,
  clinicId: string,
  slot: Interval,
): Promise<SlotHold> {
  const r = requireRedis();
  const holdId = randomUUID();
  let result: [number, number];
  try {
    result = (await r.eval(
      CREATE_HOLD,
      2,
      doctorKey(doctorId),
      holderKey(holderId),
      env.SLOT_HOLD_TTL_SECONDS * 1000,
      holdId,
      slot.startAt.getTime(),
      slot.endAt.getTime(),
      holderId,
      doctorId,
      clinicId,
    )) as [number, number];
  } catch (err) {
    console.error("Slot hold failed:", (err as Error).message);
    throw new AppError(503, "Slot holds are unavailable right now. You can still book the slot directly.");
  }

  const [held, expiresAtMs] = result;
  if (!held) {
    throw AppError.conflict("Another patient is holding this slot. Pick another time or try again shortly.", {
      heldUntil: new Date(expiresAtMs).toISOString(),
    });
  }
  return { holdId, doctorId, clinicId, startAt: slot.startAt, endAt: slot.endAt, expiresAt: new Date(expiresAtMs) };
}

/** The holder's current hold, or null. */
export async function getHold(holderId: string): Promise<SlotHold | null> {
  const r = requireRedis();
  const [cur, pttl] = await Promise.all([r.get(holderKey(holderId)), r.pttl(holderKey(holderId))]);
  if (!cur || pttl <= 0) return null;
  const sep = cur.indexOf("|");
  const m = parseMember(cur.slice(sep + 1));
  return {
    holdId: m.holdId,
    doctorId: cur.slice(0, sep),
    clinicId: m.clinicId,
    startAt: new Date(m.startMs),
    endAt: new Date(m.endMs),
    expiresAt: new Date(Date.now() + pttl),
  };
}

/** Releases the holder's hold (only if it is `holdId`, when given). Never throws. */
export async function releaseHold(holderId: string, holdId = ""): Promise<boolean> {
  return withRedis(false, async (r) => (await r.eval(RELEASE_HOLD, 1, holderKey(holderId), holdId)) === 1);
}

/** Live holds on a doctor's calendar overlapping [from, to). Empty when Redis is unavailable. */
export async function heldIntervals(doctorId: string, from: Date, to: Date): Promise<HeldInterval[]> {
  return withRedis([], async (r) => {
    const raw = await r.zrangebyscore(doctorKey(doctorId), Date.now(), "+inf", "WITHSCORES");
    const out: HeldInterval[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const m = parseMember(raw[i]!);
      if (m.startMs < to.getTime() && m.endMs > from.getTime()) {
        out.push({
          startAt: new Date(m.startMs),
          endAt: new Date(m.endMs),
          holderId: m.holderId,
          expiresAt: new Date(Number(raw[i + 1])),
        });
      }
    }
    return out;
  });
}

/**
 * Booking guard: 409 if a different user holds an overlapping slot. Fails open when Redis is
 * unavailable (Postgres still prevents double booking).
 */
export async function assertNotHeldByOthers(doctorId: string, slot: Interval, userId: string): Promise<void> {
  const other = (await heldIntervals(doctorId, slot.startAt, slot.endAt)).find((h) => h.holderId !== userId);
  if (other) {
    throw AppError.conflict("Another patient is holding this slot. Pick another time or try again shortly.", {
      heldUntil: other.expiresAt.toISOString(),
    });
  }
}
