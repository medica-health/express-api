import type { AuthUser } from "../types/auth";

// Pure record-level access rules. Callers load the facts (assignment, care relationship)
// from the database and pass them in, which keeps these functions trivially testable.

/** Who may manage a doctor's schedule, clinics and appointments. */
export function canManageDoctor(user: AuthUser, doctorId: string, isAssignedReceptionist: boolean): boolean {
  switch (user.role) {
    case "ADMIN":
      return true;
    case "DOCTOR":
      return user.id === doctorId;
    case "RECEPTIONIST":
      return isAssignedReceptionist;
    default:
      return false;
  }
}

interface AppointmentParties {
  patient_id: string;
  doctor_id: string;
}

/** Who may view an appointment. */
export function canViewAppointment(
  user: AuthUser,
  appt: AppointmentParties,
  isAssignedReceptionist: boolean,
): boolean {
  if (user.role === "PATIENT") return appt.patient_id === user.id;
  return canManageDoctor(user, appt.doctor_id, isAssignedReceptionist);
}

/**
 * Who may read a patient's clinical data (prescriptions, medical records).
 * The patient themselves, or a doctor who has actually seen them (`hasTreated`).
 * Admins and receptionists are deliberately excluded.
 */
export function canViewClinicalData(user: AuthUser, patientId: string, hasTreated: boolean): boolean {
  if (user.role === "PATIENT") return user.id === patientId;
  if (user.role === "DOCTOR") return hasTreated;
  return false;
}
