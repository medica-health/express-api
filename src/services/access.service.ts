import { query, queryOne, type Queryable } from "../db";
import { canManageDoctor } from "../policies/access";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";

// Database-backed helpers that feed the pure rules in policies/access.ts.

export async function isAssignedReceptionist(
  receptionistId: string,
  doctorId: string,
  db?: Queryable,
): Promise<boolean> {
  const row = await queryOne(
    "SELECT 1 FROM app.receptionist_assignments WHERE receptionist_id = $1 AND doctor_id = $2",
    [receptionistId, doctorId],
    db,
  );
  return !!row;
}

export async function assignedDoctorIds(receptionistId: string, db?: Queryable): Promise<string[]> {
  const rows = await query<{ doctor_id: string }>(
    "SELECT doctor_id FROM app.receptionist_assignments WHERE receptionist_id = $1",
    [receptionistId],
    db,
  );
  return rows.map((r) => r.doctor_id);
}

/** A doctor "has treated" a patient once an appointment reached check-in or completion. */
export async function hasTreated(doctorId: string, patientId: string, db?: Queryable): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM app.appointments
      WHERE doctor_id = $1 AND patient_id = $2 AND status IN ('CHECKED_IN', 'COMPLETED')
      LIMIT 1`,
    [doctorId, patientId],
    db,
  );
  return !!row;
}

/** Resolves the `me` alias in /doctors/:doctorId/... routes. */
export function resolveDoctorId(param: string, user: AuthUser): string {
  if (param !== "me") return param;
  if (user.role !== "DOCTOR") throw AppError.badRequest("'me' can only be used by doctors");
  return user.id;
}

/** Throws 403 unless the user may manage this doctor's schedule/clinics/appointments. */
export async function assertCanManageDoctor(user: AuthUser, doctorId: string, db?: Queryable): Promise<void> {
  const assigned = user.role === "RECEPTIONIST" ? await isAssignedReceptionist(user.id, doctorId, db) : false;
  if (!canManageDoctor(user, doctorId, assigned)) throw AppError.forbidden();
}
