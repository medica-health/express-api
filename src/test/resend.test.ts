import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resendConfirmation } from "../services/appointments.service";
import type { LogEntry } from "../services/mailer.service";
import { notify, type NotifyOptions } from "../services/notifications.service";
import type { AuthUser } from "../types/auth";

// Service-level tests with a fake db: queries are answered by matching the SQL text.

const patient: AuthUser = { id: "p-1", email: "p@test.io", name: "P", role: "PATIENT" };
const APPT = { id: "a-1", patient_id: "p-1", doctor_id: "d-1", clinic_id: "c-1", start_at: new Date(), end_at: new Date() };

function fakeDb(row: Record<string, unknown> | undefined) {
  return { query: async () => ({ rows: row ? [row] : [] }) } as never;
}

describe("resendConfirmation", () => {
  test("cancelled appointment -> 409 and nothing is sent", async () => {
    const send = mock(async () => "SENT" as const);
    await expect(
      resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, status: "CANCELLED" }), notify: send }),
    ).rejects.toMatchObject({ status: 409, message: "Only upcoming appointments can be re-confirmed" });
    expect(send).not.toHaveBeenCalled();
  });

  test("another patient's appointment -> 404", async () => {
    const send = mock(async () => "SENT" as const);
    await expect(
      resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, patient_id: "other", status: "BOOKED" }), notify: send }),
    ).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
  });

  test("booked appointment resends BOOKED to the patient only", async () => {
    const send = mock(async () => "SENT" as const);
    const out = await resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, status: "BOOKED" }), notify: send });
    expect(out).toEqual({ appointmentId: "a-1", sent: true });
    expect(send).toHaveBeenCalledWith("a-1", "BOOKED", { patientOnly: true });
  });

  test("a failing send still resolves with sent:false and audits", async () => {
    const send = mock(async () => {
      throw new Error("boom");
    });
    const logAudit = mock(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    const out = await resendConfirmation(patient, "a-1", {
      db: fakeDb({ ...APPT, status: "BOOKED" }),
      notify: send,
      audit: logAudit,
    });
    expect(out).toEqual({ appointmentId: "a-1", sent: false });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith("Resend confirmation failed:", "boom");
    err.mockRestore();
  });

  test("a SKIPPED or FAILED delivery reports sent:false", async () => {
    for (const status of ["SKIPPED", "FAILED"] as const) {
      const out = await resendConfirmation(patient, "a-1", {
        db: fakeDb({ ...APPT, status: "BOOKED" }),
        notify: mock(async () => status),
        audit: () => {},
      });
      expect(out).toEqual({ appointmentId: "a-1", sent: false });
    }
  });

  test("a missing appointment reports sent:false", async () => {
    const out = await resendConfirmation(patient, "a-1", {
      db: fakeDb({ ...APPT, status: "BOOKED" }),
      notify: mock(async () => null),
      audit: () => {},
    });
    expect(out.sent).toBe(false);
  });
});

// End to end through the real notify/sendSms, with the appointment, log and fetch stubbed.
describe("resendConfirmation through notify (phone patient)", () => {
  const realFetch = globalThis.fetch;
  const row = (patient_phone: string | null) => ({
    id: "a-1",
    start_at: new Date("2026-12-01T09:30:00Z"),
    timezone: "Asia/Kolkata",
    clinic_name: "City Clinic",
    clinic_address: "1 Main St, Pune",
    patient_id: "p-1",
    patient_name: "Asha",
    patient_email: "p-1@phone.medicare.invalid",
    patient_phone,
    doctor_id: "d-1",
    doctor_name: "Rao",
    doctor_email: "doc@example.com",
    cancel_reason: null,
  });
  const via = (phone: string | null, logs: LogEntry[]) => (id: string, event: "BOOKED", opts: NotifyOptions = {}) =>
    notify(id, event, { ...opts, deps: { load: async () => row(phone), log: async (e) => void logs.push(e) } });
  const resend = (phone: string | null, logs: LogEntry[]) =>
    resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, status: "BOOKED" }), notify: via(phone, logs) as never, audit: () => {} });

  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  test("Twilio accepts the SMS -> sent:true", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ sid: "SM1" }), { status: 201 })) as unknown as typeof fetch;
    const logs: LogEntry[] = [];
    expect((await resend("+919876543210", logs)).sent).toBe(true);
    expect(logs[0]!.result.status).toBe("SENT");
  });

  test("no Twilio credentials -> SMS SKIPPED -> sent:false", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { env } = await import("../config/env");
    const saved = { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
    env.TWILIO_ACCOUNT_SID = "";
    env.TWILIO_AUTH_TOKEN = "";
    try {
      const logs: LogEntry[] = [];
      expect((await resend("+919876543210", logs)).sent).toBe(false);
      expect(logs[0]!.result.status).toBe("SKIPPED");
    } finally {
      env.TWILIO_ACCOUNT_SID = saved.sid;
      env.TWILIO_AUTH_TOKEN = saved.token;
    }
  });

  test("no phone on file -> SMS SKIPPED -> sent:false", async () => {
    const logs: LogEntry[] = [];
    expect((await resend(null, logs)).sent).toBe(false);
    expect(logs[0]!.result).toMatchObject({ status: "SKIPPED", error: "no phone" });
  });
});
