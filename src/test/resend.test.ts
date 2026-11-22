import { describe, expect, mock, test } from "bun:test";
import { resendConfirmation } from "../services/appointments.service";
import type { AuthUser } from "../types/auth";

// Service-level tests with a fake db: queries are answered by matching the SQL text.

const patient: AuthUser = { id: "p-1", email: "p@test.io", name: "P", role: "PATIENT" };
const APPT = { id: "a-1", patient_id: "p-1", doctor_id: "d-1", clinic_id: "c-1", start_at: new Date(), end_at: new Date() };

function fakeDb(row: Record<string, unknown> | undefined) {
  return { query: async () => ({ rows: row ? [row] : [] }) } as never;
}

describe("resendConfirmation", () => {
  test("cancelled appointment -> 409 and nothing is sent", async () => {
    const send = mock(async () => {});
    await expect(
      resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, status: "CANCELLED" }), notify: send }),
    ).rejects.toMatchObject({ status: 409, message: "Only upcoming appointments can be re-confirmed" });
    expect(send).not.toHaveBeenCalled();
  });

  test("another patient's appointment -> 404", async () => {
    const send = mock(async () => {});
    await expect(
      resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, patient_id: "other", status: "BOOKED" }), notify: send }),
    ).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
  });

  test("booked appointment resends BOOKED to the patient only", async () => {
    const send = mock(async () => {});
    const out = await resendConfirmation(patient, "a-1", { db: fakeDb({ ...APPT, status: "BOOKED" }), notify: send });
    expect(out).toEqual({ appointmentId: "a-1" });
    expect(send).toHaveBeenCalledWith("a-1", "BOOKED", { patientOnly: true });
  });
});
