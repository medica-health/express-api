import { query, queryOne, withTransaction } from "../db";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { offsetOf, paged } from "../utils/pagination";
import { SqlBuilder } from "../utils/sql";
import type { AdminDoctorsQuery, VerificationBody } from "../validators/admin";
import { audit } from "./audit.service";
import { notifyDoctorVerification } from "./notifications.service";
import { requireUserWithRole } from "./users.service";

// ------------------------------------------------------------------ doctor verification

export async function listDoctorsForAdmin(q: AdminDoctorsQuery) {
  const b = new SqlBuilder();
  if (q.status) b.where(`dp.verification_status = ${b.param(q.status)}`);
  if (q.q) {
    const t = b.param(`%${q.q}%`);
    b.where(`(u.full_name ILIKE ${t} OR u.email::text ILIKE ${t} OR dp.registration_number ILIKE ${t})`);
  }
  const rows = await query<Record<string, unknown> & { total: string }>(
    `SELECT dp.user_id AS id, u.full_name AS name, u.email::text AS email, u.phone, u.enabled,
            s.name::text AS specialization, dp.qualifications, dp.registration_number, dp.experience_years,
            dp.verification_status, dp.rejection_reason, dp.verified_at, dp.created_at,
            (SELECT count(*) FROM app.doctor_clinics dc WHERE dc.doctor_id = dp.user_id)::int AS clinic_count,
            count(*) OVER () AS total
       FROM app.doctor_profiles dp
       JOIN auth.users u ON u.id = dp.user_id
       LEFT JOIN app.specializations s ON s.id = dp.specialization_id
       ${b.whereClause()}
      ORDER BY dp.created_at ASC
      LIMIT ${b.param(q.limit)} OFFSET ${b.param(offsetOf(q))}`,
    b.params,
  );
  const total = rows[0] ? Number(rows[0].total) : 0;
  return paged(rows.map(({ total: _t, ...r }) => r), total, q);
}

export async function setVerification(admin: AuthUser, doctorId: string, body: VerificationBody) {
  const doctor = await requireUserWithRole(doctorId, "DOCTOR");
  const row = await queryOne(
    `UPDATE app.doctor_profiles
        SET verification_status = $2, rejection_reason = $3, verified_by = $4, verified_at = now(), updated_at = now()
      WHERE user_id = $1
      RETURNING user_id AS id, verification_status, rejection_reason, verified_at`,
    [doctorId, body.status, body.status === "REJECTED" ? body.reason : null, admin.id],
  );
  if (!row) throw AppError.notFound("Doctor profile not found");
  audit(admin, `DOCTOR_${body.status}`, "doctor", doctorId, { reason: body.reason });
  notifyDoctorVerification(doctor, body.status, body.reason);
  return row;
}

// ------------------------------------------------------------------ specializations

export function listSpecializations() {
  return query(
    `SELECT s.id, s.name::text AS name, s.description,
            (SELECT count(*) FROM app.doctor_profiles dp
              WHERE dp.specialization_id = s.id AND dp.verification_status = 'APPROVED')::int AS doctor_count
       FROM app.specializations s ORDER BY s.name`,
  );
}

export async function createSpecialization(admin: AuthUser, name: string, description?: string) {
  const row = await queryOne<{ id: number }>(
    "INSERT INTO app.specializations (name, description) VALUES ($1, $2) RETURNING id, name::text AS name, description",
    [name, description ?? null],
  );
  audit(admin, "SPECIALIZATION_CREATED", "specialization", String(row!.id));
  return row;
}

export async function updateSpecialization(admin: AuthUser, id: number, name: string, description?: string) {
  const row = await queryOne(
    "UPDATE app.specializations SET name = $2, description = $3 WHERE id = $1 RETURNING id, name::text AS name, description",
    [id, name, description ?? null],
  );
  if (!row) throw AppError.notFound("Specialization not found");
  audit(admin, "SPECIALIZATION_UPDATED", "specialization", String(id));
  return row;
}

export async function deleteSpecialization(admin: AuthUser, id: number) {
  const used = await queryOne("SELECT 1 FROM app.doctor_profiles WHERE specialization_id = $1 LIMIT 1", [id]);
  if (used) throw AppError.conflict("Specialization is assigned to doctors and cannot be deleted");
  const row = await queryOne("DELETE FROM app.specializations WHERE id = $1 RETURNING id", [id]);
  if (!row) throw AppError.notFound("Specialization not found");
  audit(admin, "SPECIALIZATION_DELETED", "specialization", String(id));
}

// ------------------------------------------------------------------ receptionist assignments

export function listAssignments(filter: { receptionistId?: string; doctorId?: string }) {
  return query(
    `SELECT ra.receptionist_id, r.full_name AS receptionist_name, r.email::text AS receptionist_email,
            ra.doctor_id, d.full_name AS doctor_name, ra.created_at
       FROM app.receptionist_assignments ra
       JOIN auth.users r ON r.id = ra.receptionist_id
       JOIN auth.users d ON d.id = ra.doctor_id
      WHERE ($1::uuid IS NULL OR ra.receptionist_id = $1) AND ($2::uuid IS NULL OR ra.doctor_id = $2)
      ORDER BY r.full_name, d.full_name`,
    [filter.receptionistId ?? null, filter.doctorId ?? null],
  );
}

export async function createAssignment(admin: AuthUser, receptionistId: string, doctorId: string) {
  await withTransaction(async (tx) => {
    await requireUserWithRole(receptionistId, "RECEPTIONIST", tx);
    await requireUserWithRole(doctorId, "DOCTOR", tx);
    await query("INSERT INTO app.doctor_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [doctorId], tx);
    await query(
      `INSERT INTO app.receptionist_assignments (receptionist_id, doctor_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [receptionistId, doctorId, admin.id],
      tx,
    );
  });
  audit(admin, "RECEPTIONIST_ASSIGNED", "receptionist", receptionistId, { doctorId });
  return listAssignments({ receptionistId });
}

export async function deleteAssignment(admin: AuthUser, receptionistId: string, doctorId: string) {
  const row = await queryOne(
    "DELETE FROM app.receptionist_assignments WHERE receptionist_id = $1 AND doctor_id = $2 RETURNING 1",
    [receptionistId, doctorId],
  );
  if (!row) throw AppError.notFound("Assignment not found");
  audit(admin, "RECEPTIONIST_UNASSIGNED", "receptionist", receptionistId, { doctorId });
}

// ------------------------------------------------------------------ stats

export async function platformStats() {
  const [users, doctors, appointments, daily, topDoctors, cities] = await Promise.all([
    query("SELECT role, count(*)::int AS count FROM auth.users GROUP BY role"),
    query("SELECT verification_status AS status, count(*)::int AS count FROM app.doctor_profiles GROUP BY 1"),
    query("SELECT status, count(*)::int AS count FROM app.appointments GROUP BY status"),
    query(
      `SELECT d::date AS day, count(a.id)::int AS count
         FROM generate_series(current_date - 29, current_date, interval '1 day') d
         LEFT JOIN app.appointments a ON a.start_at::date = d::date
        GROUP BY d ORDER BY d`,
    ),
    query(
      `SELECT dp.user_id AS id, u.full_name AS name, dp.avg_rating::float AS avg_rating, dp.rating_count
         FROM app.doctor_profiles dp JOIN auth.users u ON u.id = dp.user_id
        WHERE dp.verification_status = 'APPROVED' AND dp.rating_count > 0
        ORDER BY dp.avg_rating DESC, dp.rating_count DESC LIMIT 5`,
    ),
    query(
      `SELECT c.city, count(DISTINCT dc.doctor_id)::int AS doctors
         FROM app.clinics c JOIN app.doctor_clinics dc ON dc.clinic_id = c.id
        GROUP BY c.city ORDER BY doctors DESC LIMIT 10`,
    ),
  ]);
  return { users, doctors, appointments, appointmentsLast30Days: daily, topDoctors, cities };
}
