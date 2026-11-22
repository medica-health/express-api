import { pool } from "../config/postgres";
import { query, queryOne, withTransaction, type Queryable } from "../db";
import { canViewAppointment } from "../policies/access";
import {
  allowedTransitions,
  assertPatientCanChange,
  assertTransition,
  isActive,
  type AppointmentStatus,
} from "../policies/appointmentStatus";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { offsetOf, paged } from "../utils/pagination";
import { SqlBuilder } from "../utils/sql";
import type {
  BookAppointmentBody,
  ListAppointmentsQuery,
  HoldSlotBody,
  RescheduleBody,
  UpdateStatusBody,
} from "../validators/appointments";
import { assertCanManageDoctor, assignedDoctorIds, isAssignedReceptionist } from "./access.service";
import { audit } from "./audit.service";
import { busyIntervals, candidateSlots } from "./doctors.service";
import { notify, notifyBooked, notifyCancelled, notifyRescheduled } from "./notifications.service";
import { invalidateDoctorSlots } from "./slotCache.service";
import { assertNotHeldByOthers, createHold, getHold, releaseHold } from "./slotHolds.service";
import { requireUserWithRole } from "./users.service";

interface AppointmentRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  clinic_id: string;
  start_at: Date;
  end_at: Date;
  status: AppointmentStatus;
}

const DETAIL_SELECT = `
  SELECT a.id, a.status, a.start_at, a.end_at, a.reason, a.doctor_notes,
         a.cancel_reason, a.cancelled_at, a.checked_in_at, a.completed_at, a.created_at, a.updated_at,
         a.patient_id, p.full_name AS patient_name, p.email::text AS patient_email, p.phone AS patient_phone,
         a.doctor_id, d.full_name AS doctor_name, s.name::text AS doctor_specialization,
         dp.consultation_fee::float AS consultation_fee,
         a.clinic_id, c.name AS clinic_name, c.address_line AS clinic_address, c.city AS clinic_city,
         c.timezone AS clinic_timezone,
         a.booked_by, b.full_name AS booked_by_name, cb.full_name AS cancelled_by_name,
         EXISTS (SELECT 1 FROM app.prescriptions rx WHERE rx.appointment_id = a.id) AS has_prescription,
         EXISTS (SELECT 1 FROM app.reviews rv WHERE rv.appointment_id = a.id) AS has_review
    FROM app.appointments a
    JOIN auth.users p ON p.id = a.patient_id
    JOIN auth.users d ON d.id = a.doctor_id
    JOIN app.doctor_profiles dp ON dp.user_id = a.doctor_id
    LEFT JOIN app.specializations s ON s.id = dp.specialization_id
    JOIN app.clinics c ON c.id = a.clinic_id
    JOIN auth.users b ON b.id = a.booked_by
    LEFT JOIN auth.users cb ON cb.id = a.cancelled_by`;

async function detail(id: string, user: AuthUser, db?: Queryable) {
  const row = await queryOne<{ status: AppointmentStatus }>(`${DETAIL_SELECT} WHERE a.id = $1`, [id], db);
  if (!row) throw AppError.notFound("Appointment not found");
  return { ...row, allowedActions: allowedTransitions(row.status, user.role) };
}

/** Loads (and optionally row-locks) an appointment the user is allowed to see. 404 otherwise. */
async function loadVisible(user: AuthUser, id: string, db: Queryable, forUpdate = false): Promise<AppointmentRow> {
  const row = await queryOne<AppointmentRow>(
    `SELECT id, patient_id, doctor_id, clinic_id, start_at, end_at, status
       FROM app.appointments WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [id],
    db,
  );
  if (!row) throw AppError.notFound("Appointment not found");
  const assigned = user.role === "RECEPTIONIST" ? await isAssignedReceptionist(user.id, row.doctor_id, db) : false;
  if (!canViewAppointment(user, row, assigned)) throw AppError.notFound("Appointment not found");
  return row;
}

export async function getAppointment(user: AuthUser, id: string) {
  await loadVisible(user, id, pool);
  return detail(id, user);
}

/**
 * Validates that `startAt` is exactly one of the doctor's generated slots at that clinic,
 * is in the future and doesn't fall in time off. Overlap with other appointments is
 * enforced by the appointments_doctor_no_overlap exclusion constraint (-> 409).
 */
async function resolveSlot(tx: Queryable, doctorId: string, clinicId: string, startAt: Date) {
  if (startAt.getTime() <= Date.now()) throw AppError.badRequest("The appointment time must be in the future");

  const clinic = await queryOne<{ local_date: string }>(
    `SELECT to_char(($1::timestamptz AT TIME ZONE c.timezone)::date, 'YYYY-MM-DD') AS local_date
       FROM app.clinics c
       JOIN app.doctor_clinics dc ON dc.clinic_id = c.id AND dc.doctor_id = $3
      WHERE c.id = $2`,
    [startAt, clinicId, doctorId],
    tx,
  );
  if (!clinic) throw AppError.badRequest("The doctor does not practise at this clinic");

  const slots = await candidateSlots(doctorId, clinic.local_date, clinicId, tx);
  const slot = slots.find((s) => s.startAt.getTime() === startAt.getTime());
  if (!slot) throw AppError.badRequest("The selected time is not one of the doctor's available slots");

  const off = await queryOne(
    `SELECT 1 FROM app.doctor_time_off WHERE doctor_id = $1 AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
    [doctorId, slot.startAt, slot.endAt],
    tx,
  );
  if (off) throw AppError.conflict("The doctor is unavailable at this time");
  return slot;
}

async function assertBookableDoctor(doctorId: string, db: Queryable) {
  const doctor = await queryOne<{ verification_status: string; enabled: boolean }>(
    `SELECT dp.verification_status, u.enabled FROM app.doctor_profiles dp
       JOIN auth.users u ON u.id = dp.user_id WHERE dp.user_id = $1`,
    [doctorId],
    db,
  );
  if (!doctor || !doctor.enabled || doctor.verification_status !== "APPROVED") {
    throw AppError.notFound("Doctor not found");
  }
}

/** After a booking or reschedule commits: drop the booker's hold on that slot and the slot cache. */
async function afterSlotTaken(user: AuthUser, doctorId: string, startAt: Date) {
  const hold = await getHold(user.id).catch(() => null);
  if (hold && hold.doctorId === doctorId && hold.startAt.getTime() === startAt.getTime()) {
    await releaseHold(user.id, hold.holdId);
  }
  await invalidateDoctorSlots(doctorId);
}

// ------------------------------------------------------------------ slot holds (Redis)

/**
 * Holds a free slot for the caller while they confirm the booking (see slotHolds.service).
 * Same rules as booking: patients for themselves, receptionists for assigned doctors, admins any.
 * 503 when Redis is unavailable; the client should then book directly.
 */
export async function holdSlot(user: AuthUser, body: HoldSlotBody) {
  if (user.role === "RECEPTIONIST") await assertCanManageDoctor(user, body.doctorId);
  await assertBookableDoctor(body.doctorId, pool);
  const slot = await resolveSlot(pool, body.doctorId, body.clinicId, body.startAt);
  const busy = await busyIntervals(body.doctorId, slot.startAt, slot.endAt);
  if (busy.length) throw AppError.conflict("This time slot is no longer available");
  return createHold(user.id, body.doctorId, body.clinicId, slot);
}

export async function getMyHold(user: AuthUser) {
  return getHold(user.id);
}

export async function releaseMyHold(user: AuthUser, holdId: string) {
  if (!(await releaseHold(user.id, holdId))) throw AppError.notFound("Hold not found or already expired");
}

export async function bookAppointment(user: AuthUser, body: BookAppointmentBody) {
  let patientId: string;
  if (user.role === "PATIENT") {
    patientId = user.id;
  } else {
    if (!body.patientId) throw AppError.badRequest("patientId is required when booking on behalf of a patient");
    patientId = body.patientId;
    if (user.role === "RECEPTIONIST") await assertCanManageDoctor(user, body.doctorId);
  }

  const { id, startAt } = await withTransaction(async (tx) => {
    await requireUserWithRole(patientId, "PATIENT", tx);
    await assertBookableDoctor(body.doctorId, tx);
    const slot = await resolveSlot(tx, body.doctorId, body.clinicId, body.startAt);
    await assertNotHeldByOthers(body.doctorId, slot, user.id);
    await query(
      "INSERT INTO app.patient_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [patientId],
      tx,
    );
    const row = await queryOne<{ id: string }>(
      `INSERT INTO app.appointments (patient_id, doctor_id, clinic_id, booked_by, start_at, end_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [patientId, body.doctorId, body.clinicId, user.id, slot.startAt, slot.endAt, body.reason ?? null],
      tx,
    );
    return { id: row!.id, startAt: slot.startAt };
  });

  await afterSlotTaken(user, body.doctorId, startAt);

  audit(user, "APPOINTMENT_BOOKED", "appointment", id, { doctorId: body.doctorId, patientId });
  notifyBooked(id);
  return detail(id, user);
}

export async function listAppointments(user: AuthUser, q: ListAppointmentsQuery) {
  const b = new SqlBuilder();

  // Role scoping: every role only ever sees its own slice.
  switch (user.role) {
    case "PATIENT":
      b.where(`a.patient_id = ${b.param(user.id)}`);
      break;
    case "DOCTOR":
      b.where(`a.doctor_id = ${b.param(user.id)}`);
      break;
    case "RECEPTIONIST": {
      const ids = await assignedDoctorIds(user.id);
      if (!ids.length) return paged([], 0, q);
      b.where(`a.doctor_id = ANY(${b.param(ids)}::uuid[])`);
      break;
    }
    case "ADMIN":
      break;
  }

  if (q.status?.length) b.where(`a.status = ANY(${b.param(q.status)}::text[])`);
  if (q.from) b.where(`a.start_at >= ${b.param(q.from)}`);
  if (q.to) b.where(`a.start_at < ${b.param(q.to)}`);
  if (q.doctorId) b.where(`a.doctor_id = ${b.param(q.doctorId)}`);
  if (q.patientId) b.where(`a.patient_id = ${b.param(q.patientId)}`);
  if (q.clinicId) b.where(`a.clinic_id = ${b.param(q.clinicId)}`);

  const where = b.whereClause();
  const countRow = await queryOne<{ count: string }>(
    `SELECT count(*) FROM app.appointments a ${where}`,
    b.params,
  );
  const rows = await query<{ status: AppointmentStatus }>(
    `${DETAIL_SELECT} ${where}
      ORDER BY a.start_at ${q.order === "desc" ? "DESC" : "ASC"}
      LIMIT ${b.param(q.limit)} OFFSET ${b.param(offsetOf(q))}`,
    b.params,
  );
  const items = rows.map((r) => ({ ...r, allowedActions: allowedTransitions(r.status, user.role) }));
  return paged(items, Number(countRow?.count ?? 0), q);
}

export async function updateStatus(user: AuthUser, id: string, body: UpdateStatusBody) {
  const doctorId = await withTransaction(async (tx) => {
    const appt = await loadVisible(user, id, tx, true);
    await assertCanManageDoctor(user, appt.doctor_id, tx);
    assertTransition({ from: appt.status, to: body.status, role: user.role, startAt: appt.start_at });

    const stamp = { CHECKED_IN: "checked_in_at = now(),", COMPLETED: "completed_at = now()," }[body.status as string] ?? "";
    const notes = user.role === "DOCTOR" && body.doctorNotes !== undefined;
    await query(
      `UPDATE app.appointments
          SET status = $2, ${stamp} ${notes ? "doctor_notes = $3," : ""} updated_at = now()
        WHERE id = $1`,
      notes ? [id, body.status, body.doctorNotes] : [id, body.status],
      tx,
    );
    return appt.doctor_id;
  });
  if (body.status === "NO_SHOW") await invalidateDoctorSlots(doctorId); // frees the slot
  audit(user, `APPOINTMENT_${body.status}`, "appointment", id);
  return detail(id, user);
}

export async function cancelAppointment(user: AuthUser, id: string, reason?: string) {
  const doctorId = await withTransaction(async (tx) => {
    const appt = await loadVisible(user, id, tx, true);
    if (user.role !== "PATIENT") await assertCanManageDoctor(user, appt.doctor_id, tx);
    assertTransition({ from: appt.status, to: "CANCELLED", role: user.role, startAt: appt.start_at });
    await query(
      `UPDATE app.appointments
          SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, reason ?? null, user.id],
      tx,
    );
    return appt.doctor_id;
  });
  await invalidateDoctorSlots(doctorId);
  audit(user, "APPOINTMENT_CANCELLED", "appointment", id, { reason });
  notifyCancelled(id);
  return detail(id, user);
}

export async function rescheduleAppointment(user: AuthUser, id: string, body: RescheduleBody) {
  const { doctorId, startAt } = await withTransaction(async (tx) => {
    const appt = await loadVisible(user, id, tx, true);
    if (user.role === "PATIENT") assertPatientCanChange(appt.start_at);
    else await assertCanManageDoctor(user, appt.doctor_id, tx);
    if (!isActive(appt.status)) throw AppError.conflict(`A ${appt.status} appointment cannot be rescheduled`);

    const clinicId = body.clinicId ?? appt.clinic_id;
    const slot = await resolveSlot(tx, appt.doctor_id, clinicId, body.startAt);
    await assertNotHeldByOthers(appt.doctor_id, slot, user.id);
    // Moving resets confirmation and the reminder; the exclusion constraint rejects overlaps.
    await query(
      `UPDATE app.appointments
          SET start_at = $2, end_at = $3, clinic_id = $4, status = 'BOOKED', reminder_sent_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, slot.startAt, slot.endAt, clinicId],
      tx,
    );
    return { doctorId: appt.doctor_id, startAt: slot.startAt };
  });
  await afterSlotTaken(user, doctorId, startAt);
  audit(user, "APPOINTMENT_RESCHEDULED", "appointment", id, { startAt: body.startAt });
  notifyRescheduled(id);
  return detail(id, user);
}

/**
 * Re-sends the booking confirmation to the patient (email or SMS, whichever they use).
 * Reschedules aren't tracked separately, so this always sends the BOOKED message.
 */
export async function resendConfirmation(
  user: AuthUser,
  id: string,
  deps: { db?: Queryable; notify?: typeof notify; audit?: typeof audit } = {},
): Promise<{ appointmentId: string; sent: boolean }> {
  const { db = pool, notify: send = notify, audit: log = audit } = deps;
  const appt = await loadVisible(user, id, db);
  if (user.role !== "PATIENT") await assertCanManageDoctor(user, appt.doctor_id, db);
  if (!isActive(appt.status)) throw AppError.conflict("Only upcoming appointments can be re-confirmed");
  // Notification problems must never fail the request: report them via `sent` instead.
  let sent = true;
  try {
    await send(id, "BOOKED", { patientOnly: true });
  } catch (err) {
    sent = false;
    console.error("Resend confirmation failed:", (err as Error).message);
  }
  log(user, "APPOINTMENT_CONFIRMATION_RESENT", "appointment", id, { sent });
  return { appointmentId: id, sent };
}
