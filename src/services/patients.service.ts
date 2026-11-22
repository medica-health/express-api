import { query, queryOne } from "../db";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { POINT_SQL } from "../utils/geo";
import { SqlBuilder } from "../utils/sql";
import type { UpdatePatientProfileBody } from "../validators/clinical";
import { assignedDoctorIds } from "./access.service";
import { audit } from "./audit.service";
import { assertCanViewClinical } from "./prescriptions.service";
import { findUserByEmail } from "./users.service";

const PROFILE_SELECT = `
  SELECT u.id, u.full_name AS name, u.email::text AS email, u.phone,
         pp.date_of_birth, pp.gender, pp.blood_group, pp.allergies, pp.chronic_conditions,
         pp.address_line, pp.city, pp.state, pp.pincode,
         CASE WHEN pp.location IS NULL THEN NULL ELSE ST_Y(pp.location::geometry) END AS lat,
         CASE WHEN pp.location IS NULL THEN NULL ELSE ST_X(pp.location::geometry) END AS lng,
         pp.emergency_contact_name, pp.emergency_contact_phone, pp.updated_at
    FROM auth.users u LEFT JOIN app.patient_profiles pp ON pp.user_id = u.id`;

export async function getProfile(patientId: string) {
  await query("INSERT INTO app.patient_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [patientId]);
  return queryOne(`${PROFILE_SELECT} WHERE u.id = $1`, [patientId]);
}

export async function updateProfile(patientId: string, body: UpdatePatientProfileBody) {
  await query("INSERT INTO app.patient_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [patientId]);
  const columns: Record<string, unknown> = {
    date_of_birth: body.dateOfBirth,
    gender: body.gender,
    blood_group: body.bloodGroup,
    allergies: body.allergies,
    chronic_conditions: body.chronicConditions,
    address_line: body.addressLine,
    city: body.city,
    state: body.state,
    pincode: body.pincode,
    emergency_contact_name: body.emergencyContactName,
    emergency_contact_phone: body.emergencyContactPhone,
  };
  const b = new SqlBuilder();
  const sets: string[] = [];
  for (const [col, value] of Object.entries(columns)) {
    if (value !== undefined) sets.push(`${col} = ${b.param(value)}`);
  }
  if (body.lat !== undefined && body.lng !== undefined) {
    sets.push(
      body.lat === null || body.lng === null
        ? "location = NULL"
        : `location = ${POINT_SQL(b.param(body.lng), b.param(body.lat))}`,
    );
  }
  if (sets.length) {
    await query(
      `UPDATE app.patient_profiles SET ${sets.join(", ")}, updated_at = now() WHERE user_id = ${b.param(patientId)}`,
      b.params,
    );
  }
  return getProfile(patientId);
}

/**
 * Front-desk lookup so receptionists/admins can book for an existing patient account.
 * Returns contact details only, never clinical data.
 */
export async function lookupPatientByEmail(user: AuthUser, email: string) {
  const patient = await findUserByEmail(email);
  if (!patient || patient.role !== "PATIENT" || !patient.enabled) throw AppError.notFound("Patient not found");
  audit(user, "PATIENT_LOOKUP", "patient", patient.id);
  return { id: patient.id, name: patient.full_name, email: patient.email, phone: patient.phone };
}

/** Clinical summary of a patient for a doctor who has treated them (or the patient). */
export async function getPatientSummary(user: AuthUser, patientId: string) {
  await assertCanViewClinical(user, patientId);
  const profile = await queryOne(`${PROFILE_SELECT} WHERE u.id = $1 AND u.role = 'PATIENT'`, [patientId]);
  if (!profile) throw AppError.notFound("Patient not found");
  const appointments = await query(
    `SELECT a.id, a.start_at, a.status, a.reason, d.full_name AS doctor_name, c.name AS clinic_name
       FROM app.appointments a
       JOIN auth.users d ON d.id = a.doctor_id
       JOIN app.clinics c ON c.id = a.clinic_id
      WHERE a.patient_id = $1 ORDER BY a.start_at DESC LIMIT 20`,
    [patientId],
  );
  audit(user, "PATIENT_SUMMARY_VIEWED", "patient", patientId);
  return { profile, appointments };
}

/** Patients a doctor has seen, or that a receptionist's doctors have appointments with. */
export async function listMyPatients(user: AuthUser, search?: string) {
  const doctorIds = user.role === "DOCTOR" ? [user.id] : await assignedDoctorIds(user.id);
  if (!doctorIds.length) return [];
  return query(
    `SELECT u.id, u.full_name AS name, u.email::text AS email, u.phone,
            max(a.start_at) AS last_visit, count(*)::int AS visits
       FROM app.appointments a JOIN auth.users u ON u.id = a.patient_id
      WHERE a.doctor_id = ANY($1::uuid[])
        AND ($2::text IS NULL OR u.full_name ILIKE '%' || $2 || '%' OR u.email::text ILIKE '%' || $2 || '%')
      GROUP BY u.id ORDER BY last_visit DESC LIMIT 100`,
    [doctorIds, search ?? null],
  );
}
