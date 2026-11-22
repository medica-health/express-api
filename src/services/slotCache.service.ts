import { env } from "../config/env";
import { redis, withRedis } from "../config/redis";
import type { Slot } from "../policies/slots";

// Cache of free slots per doctor/date/clinic in Redis.
//
// Invalidation uses a per-doctor version number that is part of every cache key. Any write that
// changes a doctor's free slots (booking, cancel, reschedule, availability, time off, clinic
// changes) bumps the version, which orphans all of that doctor's cached entries at once; they
// then expire via their TTL. A reader takes the version *before* querying Postgres, so a write
// that commits mid-read can never leave a stale entry under the new version.
//
// The cache is only an optimisation: on any Redis problem we read from Postgres, and booking is
// always re-validated against Postgres (exact-slot match + exclusion constraints).

const versionKey = (doctorId: string) => `slots:v:${doctorId}`;
const dataKey = (doctorId: string, version: string, date: string, clinicId?: string) =>
  `slots:${doctorId}:${version}:${date}:${clinicId ?? "all"}`;

interface CachedSlot {
  startAt: string;
  endAt: string;
  clinicId: string;
}

export async function cachedSlots(
  doctorId: string,
  date: string,
  clinicId: string | undefined,
  load: () => Promise<Slot[]>,
): Promise<Slot[]> {
  const r = redis();
  if (!r) return load();

  let key: string;
  try {
    const version = (await r.get(versionKey(doctorId))) ?? "0";
    key = dataKey(doctorId, version, date, clinicId);
    const hit = await r.get(key);
    if (hit) {
      const now = Date.now();
      return (JSON.parse(hit) as CachedSlot[])
        .map((s) => ({ startAt: new Date(s.startAt), endAt: new Date(s.endAt), clinicId: s.clinicId }))
        .filter((s) => s.startAt.getTime() >= now); // slots may have passed since caching
    }
  } catch (err) {
    console.error("Slot cache read failed:", (err as Error).message);
    return load();
  }

  const slots = await load();
  r.set(key, JSON.stringify(slots), "EX", env.SLOT_CACHE_TTL_SECONDS).catch((err: Error) => {
    console.error("Slot cache write failed:", err.message);
  });
  return slots;
}

/** Drops cached free slots for the given doctors. Call after the change has committed. */
export async function invalidateDoctorSlots(...doctorIds: string[]): Promise<void> {
  const ids = [...new Set(doctorIds)];
  if (!ids.length) return;
  await withRedis(undefined, async (r) => {
    const tx = r.multi();
    for (const id of ids) {
      tx.incr(versionKey(id));
      // Keep version keys from piling up forever. Once one expires, the version restarts at 0, and
      // every entry for the old versions expired long before (cache TTL is at most an hour).
      tx.expire(versionKey(id), 86_400);
    }
    await tx.exec();
  });
}
