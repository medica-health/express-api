import { query, queryOne } from "../db";
import { AppError } from "../utils/AppError";
import type { AvailabilityBody, TimeOffBody } from "../validators/doctors";
import { ensureDoctorProfile } from "./doctors.service";

// Weekly availability rules and time off. Callers have already checked
// assertCanManageDoctor(user, doctorId).

const AVAILABILITY_COLUMNS = `a.id, a.clinic_id, c.name AS clinic_name, a.day_of_week,
  to_char(a.start_time, 'HH24:MI') AS start_time, to_char(a.end_time, 'HH24:MI') AS end_time,
  a.slot_minutes, a.is_active, a.created_at`;

export async function listAvailability(doctorId: string) {
  return query(
    `SELECT ${AVAILABILITY_COLUMNS}
       FROM app.doctor_availability a JOIN app.clinics c ON c.id = a.clinic_id
      WHERE a.doctor_id = $1 ORDER BY a.day_of_week, a.start_time`,
    [doctorId],
  );
}

async function assertDoctorAtClinic(doctorId: string, clinicId: string) {
  const link = await queryOne("SELECT 1 FROM app.doctor_clinics WHERE doctor_id = $1 AND clinic_id = $2", [
    doctorId,
    clinicId,
  ]);
  if (!link) throw AppError.badRequest("The doctor is not linked to this clinic");
}

async function getAvailability(doctorId: string, id: string) {
  const row = await queryOne(
    `SELECT ${AVAILABILITY_COLUMNS}
       FROM app.doctor_availability a JOIN app.clinics c ON c.id = a.clinic_id
      WHERE a.doctor_id = $1 AND a.id = $2`,
    [doctorId, id],
  );
  if (!row) throw AppError.notFound("Availability rule not found");
  return row;
}

export async function createAvailability(doctorId: string, body: AvailabilityBody) {
  await ensureDoctorProfile(doctorId);
  await assertDoctorAtClinic(doctorId, body.clinicId);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO app.doctor_availability (doctor_id, clinic_id, day_of_week, start_time, end_time, slot_minutes, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [doctorId, body.clinicId, body.dayOfWeek, body.startTime, body.endTime, body.slotMinutes, body.isActive],
  );
  return getAvailability(doctorId, row!.id);
}

// Changing a rule never touches existing appointments; they keep their booked time.
export async function updateAvailability(doctorId: string, id: string, body: AvailabilityBody) {
  await getAvailability(doctorId, id);
  await assertDoctorAtClinic(doctorId, body.clinicId);
  await query(
    `UPDATE app.doctor_availability
        SET clinic_id = $3, day_of_week = $4, start_time = $5, end_time = $6, slot_minutes = $7, is_active = $8
      WHERE doctor_id = $1 AND id = $2`,
    [doctorId, id, body.clinicId, body.dayOfWeek, body.startTime, body.endTime, body.slotMinutes, body.isActive],
  );
  return getAvailability(doctorId, id);
}

export async function deleteAvailability(doctorId: string, id: string) {
  const row = await queryOne("DELETE FROM app.doctor_availability WHERE doctor_id = $1 AND id = $2 RETURNING id", [
    doctorId,
    id,
  ]);
  if (!row) throw AppError.notFound("Availability rule not found");
}

// ------------------------------------------------------------------ time off

export async function listTimeOff(doctorId: string, from?: Date, to?: Date) {
  return query(
    `SELECT id, starts_at, ends_at, reason, created_at FROM app.doctor_time_off
      WHERE doctor_id = $1
        AND ($2::timestamptz IS NULL OR ends_at > $2)
        AND ($3::timestamptz IS NULL OR starts_at < $3)
      ORDER BY starts_at`,
    [doctorId, from ?? null, to ?? null],
  );
}

/**
 * Adds time off. Active appointments inside the window are NOT cancelled automatically:
 * they are returned as `conflicts` so staff can cancel or reschedule them deliberately.
 */
export async function createTimeOff(doctorId: string, body: TimeOffBody) {
  await ensureDoctorProfile(doctorId);
  const row = await queryOne(
    `INSERT INTO app.doctor_time_off (doctor_id, starts_at, ends_at, reason)
     VALUES ($1, $2, $3, $4) RETURNING id, starts_at, ends_at, reason, created_at`,
    [doctorId, body.startsAt, body.endsAt, body.reason ?? null],
  );
  const conflicts = await query(
    `SELECT a.id, a.start_at, a.end_at, a.status, u.full_name AS patient_name
       FROM app.appointments a JOIN auth.users u ON u.id = a.patient_id
      WHERE a.doctor_id = $1 AND a.status IN ('BOOKED', 'CONFIRMED')
        AND a.start_at < $3 AND a.end_at > $2
      ORDER BY a.start_at`,
    [doctorId, body.startsAt, body.endsAt],
  );
  return { timeOff: row, conflicts };
}

export async function deleteTimeOff(doctorId: string, id: string) {
  const row = await queryOne("DELETE FROM app.doctor_time_off WHERE doctor_id = $1 AND id = $2 RETURNING id", [
    doctorId,
    id,
  ]);
  if (!row) throw AppError.notFound("Time off not found");
}
