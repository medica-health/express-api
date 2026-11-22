import type { Role } from "../types/auth";
import { AppError } from "../utils/AppError";

export const APPOINTMENT_STATUSES = [
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Patients may cancel or reschedule only up to this many hours before the start. */
export const PATIENT_CHANGE_CUTOFF_HOURS = 2;
/** Check-in opens this many minutes before the appointment starts. */
export const CHECK_IN_WINDOW_MINUTES = 60;

const STAFF: Role[] = ["DOCTOR", "RECEPTIONIST", "ADMIN"];
const EVERYONE: Role[] = ["PATIENT", "DOCTOR", "RECEPTIONIST", "ADMIN"];

// from -> to -> roles allowed to make that move (record ownership is checked separately)
const TRANSITIONS: Partial<Record<AppointmentStatus, Partial<Record<AppointmentStatus, Role[]>>>> = {
  BOOKED: { CONFIRMED: STAFF, CANCELLED: EVERYONE, NO_SHOW: STAFF },
  CONFIRMED: { CHECKED_IN: STAFF, CANCELLED: EVERYONE, NO_SHOW: STAFF },
  CHECKED_IN: { COMPLETED: ["DOCTOR"] },
};

export function allowedTransitions(from: AppointmentStatus, role: Role): AppointmentStatus[] {
  const targets = TRANSITIONS[from] ?? {};
  return (Object.keys(targets) as AppointmentStatus[]).filter((to) => targets[to]?.includes(role));
}

export function isActive(status: AppointmentStatus): boolean {
  return status === "BOOKED" || status === "CONFIRMED";
}

interface TransitionInput {
  from: AppointmentStatus;
  to: AppointmentStatus;
  role: Role;
  startAt: Date;
  now?: Date;
}

// Throws an AppError when the move isn't allowed for this role at this time.
export function assertTransition({ from, to, role, startAt, now = new Date() }: TransitionInput): void {
  if (from === to) throw AppError.conflict(`Appointment is already ${from}`);

  const roles = TRANSITIONS[from]?.[to];
  if (!roles) throw AppError.conflict(`Cannot change appointment from ${from} to ${to}`);
  if (!roles.includes(role)) throw AppError.forbidden(`A ${role.toLowerCase()} cannot mark an appointment ${to}`);

  const minutesUntilStart = (startAt.getTime() - now.getTime()) / 60_000;

  if (to === "CANCELLED" && role === "PATIENT") assertPatientCanChange(startAt, now);
  if (to === "CHECKED_IN" && minutesUntilStart > CHECK_IN_WINDOW_MINUTES) {
    throw AppError.badRequest(`Check-in opens ${CHECK_IN_WINDOW_MINUTES} minutes before the appointment`);
  }
  if (to === "NO_SHOW" && minutesUntilStart > 0) {
    throw AppError.badRequest("An appointment can only be marked as no-show after it has started");
  }
}

export function assertPatientCanChange(startAt: Date, now: Date = new Date()): void {
  const hoursUntilStart = (startAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursUntilStart < PATIENT_CHANGE_CUTOFF_HOURS) {
    throw AppError.badRequest(
      `Appointments can only be changed up to ${PATIENT_CHANGE_CUTOFF_HOURS} hours before they start`,
    );
  }
}
