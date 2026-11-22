import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectRedis, disconnectRedis, redis } from "../config/redis";
import { errorHandler } from "../middlewares/errorHandler";
import { rateLimit } from "../middlewares/rateLimit";
import type { Slot } from "../policies/slots";
import { cachedSlots, invalidateDoctorSlots } from "../services/slotCache.service";
import {
  assertNotHeldByOthers,
  createHold,
  getHold,
  heldIntervals,
  parseMember,
  releaseHold,
} from "../services/slotHolds.service";
import type { AppError } from "../utils/AppError";

const withRedis = Boolean(process.env.TEST_REDIS_URL);
const MIN = 60_000;
const base = Date.now() + 24 * 60 * MIN;
const slotAt = (offsetMin: number, minutes = 30) => ({
  startAt: new Date(base + offsetMin * MIN),
  endAt: new Date(base + (offsetMin + minutes) * MIN),
});

async function conflict(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected the promise to reject");
}

function limitedApp(limit: number) {
  const app = express();
  app.get("/x", rateLimit({ name: `t-${randomUUID()}`, limit, windowSeconds: 60 }), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<[Server, string]> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

test("parseMember splits a hold member", () => {
  expect(parseMember("h1|100|200|u1|c1")).toEqual({ holdId: "h1", startMs: 100, endMs: 200, holderId: "u1", clinicId: "c1" });
});

// ---------------------------------------------------------------- without Redis: everything fails open

describe.skipIf(withRedis)("without Redis", () => {
  test("holds are refused with 503 so the client books directly", async () => {
    const err = await conflict(createHold(randomUUID(), randomUUID(), randomUUID(), slotAt(0)));
    expect(err.status).toBe(503);
  });

  test("the booking guard and hold listing are no-ops", async () => {
    await assertNotHeldByOthers(randomUUID(), slotAt(0), randomUUID());
    expect(await heldIntervals(randomUUID(), new Date(0), new Date(base * 2))).toEqual([]);
  });

  test("the slot cache always loads from the database", async () => {
    let loads = 0;
    const load = async () => (loads++, [] as Slot[]);
    await cachedSlots("d", "2030-01-01", undefined, load);
    await cachedSlots("d", "2030-01-01", undefined, load);
    expect(loads).toBe(2);
  });

  test("rate limiting is skipped", async () => {
    const [server, url] = await listen(limitedApp(1));
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${url}/x`)).status);
    server.close();
    expect(statuses).toEqual([200, 200, 200]);
  });
});

// ---------------------------------------------------------------- against a real Redis (TEST_REDIS_URL)

describe.skipIf(!withRedis)("with Redis", () => {
  beforeAll(async () => {
    await connectRedis();
    if (!redis()) throw new Error("TEST_REDIS_URL is set but Redis is not reachable");
  });
  afterAll(async () => {
    await disconnectRedis();
  });

  test("a slot held by one user can't be held by another", async () => {
    const doctor = randomUUID();
    const [alice, bob] = [randomUUID(), randomUUID()];
    const hold = await createHold(alice, doctor, "c1", slotAt(0));
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const err = await conflict(createHold(bob, doctor, "c1", slotAt(0)));
    expect(err.status).toBe(409);
    expect((err.details as { heldUntil: string }).heldUntil).toBe(hold.expiresAt.toISOString());

    // Overlapping slot of a different length is also blocked; the adjacent one isn't.
    expect((await conflict(createHold(bob, doctor, "c1", slotAt(15, 15)))).status).toBe(409);
    await createHold(bob, doctor, "c1", slotAt(30));
  });

  test("holding a new slot releases the user's previous hold", async () => {
    const doctor = randomUUID();
    const [alice, bob] = [randomUUID(), randomUUID()];
    await createHold(alice, doctor, "c1", slotAt(0));
    const second = await createHold(alice, doctor, "c1", slotAt(60));
    expect((await getHold(alice))?.holdId).toBe(second.holdId);
    await createHold(bob, doctor, "c1", slotAt(0)); // free again
    expect((await heldIntervals(doctor, new Date(0), new Date(base * 2))).length).toBe(2);
  });

  test("release only removes the caller's own hold", async () => {
    const doctor = randomUUID();
    const [alice, bob] = [randomUUID(), randomUUID()];
    const hold = await createHold(alice, doctor, "c1", slotAt(0));
    expect(await releaseHold(bob, hold.holdId)).toBe(false);
    expect(await releaseHold(alice, randomUUID())).toBe(false);
    expect(await releaseHold(alice, hold.holdId)).toBe(true);
    expect(await getHold(alice)).toBeNull();
    await createHold(bob, doctor, "c1", slotAt(0));
  });

  test("booking guard lets the holder through and blocks everyone else", async () => {
    const doctor = randomUUID();
    const [alice, bob] = [randomUUID(), randomUUID()];
    await createHold(alice, doctor, "c1", slotAt(0));
    await assertNotHeldByOthers(doctor, slotAt(0), alice);
    expect((await conflict(assertNotHeldByOthers(doctor, slotAt(0), bob))).status).toBe(409);
    await assertNotHeldByOthers(doctor, slotAt(30), bob);
  });

  test("concurrent holds on one slot: exactly one wins", async () => {
    const doctor = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => createHold(randomUUID(), doctor, "c1", slotAt(0))),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as AppError).status === 409).length).toBe(19);
  });

  test("slot cache serves hits, drops passed slots and is invalidated per doctor", async () => {
    const doctor = randomUUID();
    const other = randomUUID();
    let loads = 0;
    const slots: Slot[] = [
      { startAt: new Date(Date.now() - MIN), endAt: new Date(Date.now() + 29 * MIN), clinicId: "c1" },
      { ...slotAt(0), clinicId: "c1" },
    ];
    const load = async () => (loads++, slots);

    expect((await cachedSlots(doctor, "2030-01-01", undefined, load)).length).toBe(2);
    await Bun.sleep(20); // cache write is fire-and-forget
    const hit = await cachedSlots(doctor, "2030-01-01", undefined, load);
    expect(loads).toBe(1);
    expect(hit).toEqual([{ ...slotAt(0), clinicId: "c1" }]); // the passed slot is filtered out

    await invalidateDoctorSlots(other);
    await cachedSlots(doctor, "2030-01-01", undefined, load);
    expect(loads).toBe(1);

    await invalidateDoctorSlots(doctor);
    await cachedSlots(doctor, "2030-01-01", undefined, load);
    expect(loads).toBe(2);
  });

  test("rate limit returns 429 with Retry-After once the window is used up", async () => {
    const [server, url] = await listen(limitedApp(3));
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await fetch(`${url}/x`));
    server.close();
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 429]);
    expect(responses[2]!.headers.get("RateLimit-Remaining")).toBe("0");
    expect(Number(responses[3]!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await responses[3]!.json()) as { success: boolean }).success).toBe(false);
  });
});
