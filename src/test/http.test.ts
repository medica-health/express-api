import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import type { Role } from "../types/auth";

// HTTP-level tests for authentication, role gates and validation. Every request here is
// rejected before any database access, so no Postgres/Mongo is needed.

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

async function token(role: Role, opts: { secret?: string; exp?: string; issuer?: string } = {}) {
  return new SignJWT({ email: `${role.toLowerCase()}@test.io`, name: "Test", role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("00000000-0000-4000-8000-000000000001")
    .setIssuer(opts.issuer ?? "cdac-auth")
    .setAudience("cdac-api")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(new TextEncoder().encode(opts.secret ?? process.env.JWT_SECRET!));
}

async function call(path: string, init: RequestInit & { bearer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(base + path, { ...init, headers });
  return { status: res.status, body: (await res.json()) as { success: boolean; message: string; data?: unknown } };
}

describe("envelope & routing", () => {
  test("root responds Running", async () => {
    const res = await fetch(`${base}/`);
    expect(await res.json()).toEqual({ message: "Running" });
  });

  test("unknown route returns a 404 envelope", async () => {
    const { status, body } = await call("/api/nope");
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

describe("authentication", () => {
  test("missing token -> 401", async () => {
    const { status, body } = await call("/api/appointments");
    expect(status).toBe(401);
    expect(body.message).toBe("Authentication required");
  });

  test("token signed with the wrong secret -> 401", async () => {
    const bad = await token("PATIENT", { secret: "another-secret-another-secret-123456" });
    expect((await call("/api/appointments", { bearer: bad })).status).toBe(401);
  });

  test("expired token -> 401 'Token expired'", async () => {
    const expired = await token("PATIENT", { exp: "-1m" });
    const { status, body } = await call("/api/appointments", { bearer: expired });
    expect(status).toBe(401);
    expect(body.message).toBe("Token expired");
  });

  test("wrong issuer -> 401", async () => {
    const foreign = await token("ADMIN", { issuer: "someone-else" });
    expect((await call("/api/admin/stats", { bearer: foreign })).status).toBe(401);
  });
});

describe("role gates", () => {
  test("non-admins cannot reach /api/admin", async () => {
    for (const role of ["PATIENT", "DOCTOR", "RECEPTIONIST"] as const) {
      expect((await call("/api/admin/stats", { bearer: await token(role) })).status).toBe(403);
    }
  });

  test("doctors cannot book appointments", async () => {
    const { status } = await call("/api/appointments", {
      method: "POST",
      bearer: await token("DOCTOR"),
      body: JSON.stringify({}),
    });
    expect(status).toBe(403);
  });

  test("doctors cannot hold slots, and hold bodies are validated", async () => {
    const forbidden = await call("/api/appointments/holds", {
      method: "POST",
      bearer: await token("DOCTOR"),
      body: JSON.stringify({}),
    });
    expect(forbidden.status).toBe(403);
    const invalid = await call("/api/appointments/holds", {
      method: "POST",
      bearer: await token("PATIENT"),
      body: JSON.stringify({ doctorId: "nope" }),
    });
    expect(invalid.status).toBe(400);
  });

  test("patients cannot change appointment status", async () => {
    const { status } = await call("/api/appointments/00000000-0000-4000-8000-000000000009/status", {
      method: "PATCH",
      bearer: await token("PATIENT"),
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(status).toBe(403);
  });

  test("receptionists cannot read clinical records", async () => {
    expect((await call("/api/medical-records", { bearer: await token("RECEPTIONIST") })).status).toBe(403);
  });
});

describe("validation", () => {
  test("doctor search rejects out-of-range coordinates", async () => {
    const { status, body } = await call("/api/doctors?lat=123&lng=73.8");
    expect(status).toBe(400);
    expect(body.data).toHaveProperty("lat");
  });

  test("doctor search requires lat and lng together", async () => {
    expect((await call("/api/doctors?lat=18.5")).status).toBe(400);
  });

  test("booking body is validated", async () => {
    const { status, body } = await call("/api/appointments", {
      method: "POST",
      bearer: await token("PATIENT"),
      body: JSON.stringify({ doctorId: "not-a-uuid", startAt: "tomorrow" }),
    });
    expect(status).toBe(400);
    expect(body.data).toHaveProperty("doctorId");
    expect(body.data).toHaveProperty("clinicId");
    expect(body.data).toHaveProperty("startAt");
  });

  test("malformed JSON -> 400", async () => {
    const { status } = await call("/api/appointments", { method: "POST", bearer: await token("PATIENT"), body: "{oops" });
    expect(status).toBe(400);
  });

  test("rejection requires a reason", async () => {
    const { status, body } = await call("/api/admin/doctors/00000000-0000-4000-8000-000000000002/verification", {
      method: "PATCH",
      bearer: await token("ADMIN"),
      body: JSON.stringify({ status: "REJECTED" }),
    });
    expect(status).toBe(400);
    expect(body.data).toHaveProperty("reason");
  });
});
