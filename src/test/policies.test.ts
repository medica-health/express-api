import { describe, expect, test } from "bun:test";
import { canManageDoctor, canViewAppointment, canViewClinicalData } from "../policies/access";
import { filterAvailableSlots } from "../policies/slots";
import type { AuthUser, Role } from "../types/auth";

const user = (role: Role, id = `${role.toLowerCase()}-1`): AuthUser => ({ id, role, email: `${id}@x.io`, name: id });

describe("access policies", () => {
  test("doctor manages only themselves", () => {
    expect(canManageDoctor(user("DOCTOR", "d1"), "d1", false)).toBe(true);
    expect(canManageDoctor(user("DOCTOR", "d1"), "d2", false)).toBe(false);
  });

  test("receptionist needs an assignment; admin always allowed; patient never", () => {
    expect(canManageDoctor(user("RECEPTIONIST"), "d1", true)).toBe(true);
    expect(canManageDoctor(user("RECEPTIONIST"), "d1", false)).toBe(false);
    expect(canManageDoctor(user("ADMIN"), "d1", false)).toBe(true);
    expect(canManageDoctor(user("PATIENT"), "d1", true)).toBe(false);
  });

  test("patients only see their own appointments", () => {
    const appt = { patient_id: "p1", doctor_id: "d1" };
    expect(canViewAppointment(user("PATIENT", "p1"), appt, false)).toBe(true);
    expect(canViewAppointment(user("PATIENT", "p2"), appt, false)).toBe(false);
    expect(canViewAppointment(user("DOCTOR", "d1"), appt, false)).toBe(true);
    expect(canViewAppointment(user("DOCTOR", "d2"), appt, false)).toBe(false);
  });

  test("clinical data: patient or treating doctor only, never admin/receptionist", () => {
    expect(canViewClinicalData(user("PATIENT", "p1"), "p1", false)).toBe(true);
    expect(canViewClinicalData(user("PATIENT", "p2"), "p1", false)).toBe(false);
    expect(canViewClinicalData(user("DOCTOR"), "p1", true)).toBe(true);
    expect(canViewClinicalData(user("DOCTOR"), "p1", false)).toBe(false);
    expect(canViewClinicalData(user("ADMIN"), "p1", true)).toBe(false);
    expect(canViewClinicalData(user("RECEPTIONIST"), "p1", true)).toBe(false);
  });
});

describe("filterAvailableSlots", () => {
  const at = (hhmm: string) => new Date(`2026-06-01T${hhmm}:00Z`);
  const slot = (start: string, end: string) => ({ startAt: at(start), endAt: at(end), clinicId: "c1" });
  const candidates = [slot("10:40", "11:00"), slot("10:00", "10:20"), slot("10:20", "10:40"), slot("11:00", "11:20")];

  test("drops booked and time-off overlaps, keeps adjacent slots, sorts by time", () => {
    const busy = [
      { startAt: at("10:20"), endAt: at("10:40") }, // booked appointment
      { startAt: at("10:50"), endAt: at("11:05") }, // partial time off overlaps two slots
    ];
    const result = filterAvailableSlots(candidates, busy, at("08:00"));
    expect(result.map((s) => s.startAt.toISOString().slice(11, 16))).toEqual(["10:00"]);
  });

  test("drops past slots and respects lead time", () => {
    const result = filterAvailableSlots(candidates, [], at("10:10"), 15);
    expect(result.map((s) => s.startAt.toISOString().slice(11, 16))).toEqual(["10:40", "11:00"]);
  });
});
