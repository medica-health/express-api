import { query, queryOne, withTransaction, type Queryable } from "../db";
import { canViewClinicalData } from "../policies/access";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { offsetOf, paged, type Pagination } from "../utils/pagination";
import type { PrescriptionBody } from "../validators/clinical";
import { hasTreated } from "./access.service";
import { audit } from "./audit.service";

const RX_SELECT = `
  SELECT rx.id, rx.appointment_id, rx.diagnosis, rx.notes, rx.advice, rx.follow_up_date,
         rx.created_at, rx.updated_at,
         rx.doctor_id, d.full_name AS doctor_name, s.name::text AS doctor_specialization,
         dp.registration_number AS doctor_registration_number,
         rx.patient_id, p.full_name AS patient_name,
         a.start_at AS appointment_start_at, c.name AS clinic_name,
         COALESCE((SELECT json_agg(json_build_object(
                    'medicine', i.medicine, 'dosage', i.dosage, 'frequency', i.frequency,
                    'duration', i.duration, 'instructions', i.instructions) ORDER BY i.position)
                   FROM app.prescription_items i WHERE i.prescription_id = rx.id), '[]'::json) AS items
    FROM app.prescriptions rx
    JOIN auth.users d ON d.id = rx.doctor_id
    JOIN app.doctor_profiles dp ON dp.user_id = rx.doctor_id
    LEFT JOIN app.specializations s ON s.id = dp.specialization_id
    JOIN auth.users p ON p.id = rx.patient_id
    JOIN app.appointments a ON a.id = rx.appointment_id
    JOIN app.clinics c ON c.id = a.clinic_id`;

/** Throws 404 unless the user may read this patient's clinical data. */
export async function assertCanViewClinical(user: AuthUser, patientId: string, db?: Queryable) {
  const treated = user.role === "DOCTOR" ? await hasTreated(user.id, patientId, db) : false;
  if (!canViewClinicalData(user, patientId, treated)) throw AppError.notFound("Not found");
}

async function writeItems(db: Queryable, prescriptionId: string, items: PrescriptionBody["items"]) {
  await query("DELETE FROM app.prescription_items WHERE prescription_id = $1", [prescriptionId], db);
  for (const [position, item] of items.entries()) {
    await query(
      `INSERT INTO app.prescription_items (prescription_id, medicine, dosage, frequency, duration, instructions, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [prescriptionId, item.medicine, item.dosage, item.frequency, item.duration, item.instructions ?? null, position],
      db,
    );
  }
}

/**
 * The appointment's own doctor writes (or replaces) its prescription once the patient
 * has checked in, i.e. during or after the consultation.
 */
export async function upsertPrescription(user: AuthUser, appointmentId: string, body: PrescriptionBody) {
  const id = await withTransaction(async (tx) => {
    const appt = await queryOne<{ doctor_id: string; patient_id: string; status: string }>(
      "SELECT doctor_id, patient_id, status FROM app.appointments WHERE id = $1 FOR UPDATE",
      [appointmentId],
      tx,
    );
    if (!appt || appt.doctor_id !== user.id) throw AppError.notFound("Appointment not found");
    if (appt.status !== "CHECKED_IN" && appt.status !== "COMPLETED") {
      throw AppError.badRequest("A prescription can only be written once the patient has checked in");
    }
    const row = await queryOne<{ id: string }>(
      `INSERT INTO app.prescriptions (appointment_id, doctor_id, patient_id, diagnosis, notes, advice, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (appointment_id) DO UPDATE
         SET diagnosis = EXCLUDED.diagnosis, notes = EXCLUDED.notes, advice = EXCLUDED.advice,
             follow_up_date = EXCLUDED.follow_up_date, updated_at = now()
       RETURNING id`,
      [
        appointmentId,
        user.id,
        appt.patient_id,
        body.diagnosis,
        body.notes ?? null,
        body.advice ?? null,
        body.followUpDate ?? null,
      ],
      tx,
    );
    await writeItems(tx, row!.id, body.items);
    return row!.id;
  });
  audit(user, "PRESCRIPTION_WRITTEN", "prescription", id, { appointmentId });
  return getPrescriptionById(user, id);
}

export async function getPrescriptionById(user: AuthUser, id: string) {
  const rx = await queryOne<{ patient_id: string }>(`${RX_SELECT} WHERE rx.id = $1`, [id]);
  if (!rx) throw AppError.notFound("Prescription not found");
  await assertCanViewClinical(user, rx.patient_id);
  audit(user, "PRESCRIPTION_VIEWED", "prescription", id);
  return rx;
}

export async function getPrescriptionForAppointment(user: AuthUser, appointmentId: string) {
  const rx = await queryOne<{ id: string }>("SELECT id FROM app.prescriptions WHERE appointment_id = $1", [
    appointmentId,
  ]);
  if (!rx) throw AppError.notFound("No prescription for this appointment");
  return getPrescriptionById(user, rx.id);
}

export async function listPatientPrescriptions(user: AuthUser, patientId: string, p: Pagination) {
  await assertCanViewClinical(user, patientId);
  const count = await queryOne<{ count: string }>("SELECT count(*) FROM app.prescriptions WHERE patient_id = $1", [
    patientId,
  ]);
  const rows = await query(`${RX_SELECT} WHERE rx.patient_id = $1 ORDER BY rx.created_at DESC LIMIT $2 OFFSET $3`, [
    patientId,
    p.limit,
    offsetOf(p),
  ]);
  return paged(rows, Number(count?.count ?? 0), p);
}
