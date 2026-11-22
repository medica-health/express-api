import { describe, expect, test } from "bun:test";
import { allowedTransitions, assertTransition } from "../policies/appointmentStatus";
import type { AppError } from "../utils/AppError";

const now = new Date("2026-06-01T10:00:00Z");
const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3_600_000);

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as AppError).status;
  }
}

describe("assertTransition", () => {
  test("doctor can confirm, check in and complete their flow", () => {
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "CONFIRMED", role: "DOCTOR", startAt: hoursFromNow(5), now }))).toBeNull();
    expect(statusOf(() => assertTransition({ from: "CONFIRMED", to: "CHECKED_IN", role: "DOCTOR", startAt: hoursFromNow(0.5), now }))).toBeNull();
    expect(statusOf(() => assertTransition({ from: "CHECKED_IN", to: "COMPLETED", role: "DOCTOR", startAt: hoursFromNow(-0.5), now }))).toBeNull();
  });

  test("only doctors complete appointments", () => {
    expect(statusOf(() => assertTransition({ from: "CHECKED_IN", to: "COMPLETED", role: "RECEPTIONIST", startAt: now, now }))).toBe(403);
    expect(statusOf(() => assertTransition({ from: "CHECKED_IN", to: "COMPLETED", role: "ADMIN", startAt: now, now }))).toBe(403);
  });

  test("patients cannot confirm their own appointment", () => {
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "CONFIRMED", role: "PATIENT", startAt: hoursFromNow(5), now }))).toBe(403);
  });

  test("patient cancellation respects the 2 hour cutoff", () => {
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "CANCELLED", role: "PATIENT", startAt: hoursFromNow(3), now }))).toBeNull();
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "CANCELLED", role: "PATIENT", startAt: hoursFromNow(1), now }))).toBe(400);
    // staff are not bound by the cutoff
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "CANCELLED", role: "RECEPTIONIST", startAt: hoursFromNow(1), now }))).toBeNull();
  });

  test("terminal and invalid moves are conflicts", () => {
    expect(statusOf(() => assertTransition({ from: "COMPLETED", to: "CANCELLED", role: "ADMIN", startAt: now, now }))).toBe(409);
    expect(statusOf(() => assertTransition({ from: "BOOKED", to: "COMPLETED", role: "DOCTOR", startAt: now, now }))).toBe(409);
    expect(statusOf(() => assertTransition({ from: "CANCELLED", to: "CANCELLED", role: "ADMIN", startAt: now, now }))).toBe(409);
  });

  test("check-in window and no-show timing", () => {
    expect(statusOf(() => assertTransition({ from: "CONFIRMED", to: "CHECKED_IN", role: "RECEPTIONIST", startAt: hoursFromNow(3), now }))).toBe(400);
    expect(statusOf(() => assertTransition({ from: "CONFIRMED", to: "NO_SHOW", role: "DOCTOR", startAt: hoursFromNow(1), now }))).toBe(400);
    expect(statusOf(() => assertTransition({ from: "CONFIRMED", to: "NO_SHOW", role: "DOCTOR", startAt: hoursFromNow(-0.25), now }))).toBeNull();
  });
});

describe("allowedTransitions", () => {
  test("lists only the moves a role can make", () => {
    expect(allowedTransitions("BOOKED", "PATIENT")).toEqual(["CANCELLED"]);
    expect(allowedTransitions("CHECKED_IN", "DOCTOR")).toEqual(["COMPLETED"]);
    expect(allowedTransitions("CHECKED_IN", "RECEPTIONIST")).toEqual([]);
    expect(allowedTransitions("COMPLETED", "ADMIN")).toEqual([]);
  });
});
