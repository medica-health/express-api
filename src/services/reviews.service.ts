import { query, queryOne, withTransaction, type Queryable } from "../db";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { offsetOf, paged, type Pagination } from "../utils/pagination";
import type { ReviewBody } from "../validators/clinical";
import { audit } from "./audit.service";

async function refreshDoctorRating(doctorId: string, db: Queryable) {
  await query(
    `UPDATE app.doctor_profiles dp
        SET avg_rating = COALESCE(r.avg, 0), rating_count = COALESCE(r.cnt, 0), updated_at = now()
       FROM (SELECT round(avg(rating)::numeric, 2) AS avg, count(*)::int AS cnt
               FROM app.reviews WHERE doctor_id = $1) r
      WHERE dp.user_id = $1`,
    [doctorId],
    db,
  );
}

/** A patient can review each of their COMPLETED appointments once. */
export async function createReview(user: AuthUser, appointmentId: string, body: ReviewBody) {
  const review = await withTransaction(async (tx) => {
    const appt = await queryOne<{ patient_id: string; doctor_id: string; status: string }>(
      "SELECT patient_id, doctor_id, status FROM app.appointments WHERE id = $1",
      [appointmentId],
      tx,
    );
    if (!appt || appt.patient_id !== user.id) throw AppError.notFound("Appointment not found");
    if (appt.status !== "COMPLETED") throw AppError.badRequest("Only completed appointments can be reviewed");

    const row = await queryOne<{ id: string }>(
      `INSERT INTO app.reviews (appointment_id, doctor_id, patient_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, rating, comment, created_at`,
      [appointmentId, appt.doctor_id, user.id, body.rating, body.comment ?? null],
      tx,
    );
    await refreshDoctorRating(appt.doctor_id, tx);
    return row!;
  });
  audit(user, "REVIEW_CREATED", "review", review.id, { appointmentId });
  return review;
}

/** Public list. Reviewer names are shortened to "First L." for privacy. */
export async function listDoctorReviews(doctorId: string, p: Pagination) {
  const count = await queryOne<{ count: string }>("SELECT count(*) FROM app.reviews WHERE doctor_id = $1", [doctorId]);
  const rows = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            split_part(u.full_name, ' ', 1) ||
              CASE WHEN position(' ' IN u.full_name) > 0
                   THEN ' ' || left(split_part(u.full_name, ' ', 2), 1) || '.' ELSE '' END AS reviewer
       FROM app.reviews r JOIN auth.users u ON u.id = r.patient_id
      WHERE r.doctor_id = $1
      ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [doctorId, p.limit, offsetOf(p)],
  );
  return paged(rows, Number(count?.count ?? 0), p);
}

export async function deleteReview(user: AuthUser, id: string) {
  await withTransaction(async (tx) => {
    const row = await queryOne<{ doctor_id: string }>("DELETE FROM app.reviews WHERE id = $1 RETURNING doctor_id", [id], tx);
    if (!row) throw AppError.notFound("Review not found");
    await refreshDoctorRating(row.doctor_id, tx);
  });
  audit(user, "REVIEW_DELETED", "review", id);
}
