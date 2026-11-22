import { query, queryOne } from "../db";
import type { AuthUser } from "../types/auth";
import { assignedDoctorIds } from "./access.service";

const UPCOMING = `
  SELECT a.id, a.start_at, a.end_at, a.status, a.reason,
         p.full_name AS patient_name, d.full_name AS doctor_name, c.name AS clinic_name, c.city AS clinic_city
    FROM app.appointments a
    JOIN auth.users p ON p.id = a.patient_id
    JOIN auth.users d ON d.id = a.doctor_id
    JOIN app.clinics c ON c.id = a.clinic_id`;

// "Today" is evaluated in Asia/Kolkata, the platform's default clinic time zone.
const TODAY = `a.start_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
  AND a.start_at < ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata')`;

async function statusCounts(column: "patient_id" | "doctor_id", ids: string[]) {
  const rows = await query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM app.appointments WHERE ${column} = ANY($1::uuid[]) GROUP BY status`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export async function dashboardFor(user: AuthUser) {
  switch (user.role) {
    case "PATIENT": {
      const [upcoming, counts, prescriptions, pendingReviews] = await Promise.all([
        query(
          `${UPCOMING} WHERE a.patient_id = $1 AND a.start_at > now() AND a.status IN ('BOOKED','CONFIRMED')
            ORDER BY a.start_at LIMIT 5`,
          [user.id],
        ),
        statusCounts("patient_id", [user.id]),
        query(
          `SELECT rx.id, rx.diagnosis, rx.created_at, d.full_name AS doctor_name
             FROM app.prescriptions rx JOIN auth.users d ON d.id = rx.doctor_id
            WHERE rx.patient_id = $1 ORDER BY rx.created_at DESC LIMIT 5`,
          [user.id],
        ),
        query(
          `${UPCOMING} WHERE a.patient_id = $1 AND a.status = 'COMPLETED'
              AND NOT EXISTS (SELECT 1 FROM app.reviews r WHERE r.appointment_id = a.id)
            ORDER BY a.start_at DESC LIMIT 5`,
          [user.id],
        ),
      ]);
      return { role: user.role, upcoming, counts, recentPrescriptions: prescriptions, awaitingReview: pendingReviews };
    }

    case "DOCTOR": {
      const [profile, today, counts, nextUp] = await Promise.all([
        queryOne(
          `SELECT verification_status, rejection_reason, avg_rating::float AS avg_rating, rating_count
             FROM app.doctor_profiles WHERE user_id = $1`,
          [user.id],
        ),
        query(`${UPCOMING} WHERE a.doctor_id = $1 AND ${TODAY} ORDER BY a.start_at`, [user.id]),
        statusCounts("doctor_id", [user.id]),
        query(
          `${UPCOMING} WHERE a.doctor_id = $1 AND a.start_at > now() AND a.status IN ('BOOKED','CONFIRMED')
            ORDER BY a.start_at LIMIT 10`,
          [user.id],
        ),
      ]);
      return { role: user.role, profile: profile ?? { verification_status: "PENDING" }, today, upcoming: nextUp, counts };
    }

    case "RECEPTIONIST": {
      const ids = await assignedDoctorIds(user.id);
      const [doctors, today] = await Promise.all([
        query(
          `SELECT u.id, u.full_name AS name FROM auth.users u WHERE u.id = ANY($1::uuid[]) ORDER BY u.full_name`,
          [ids],
        ),
        query(`${UPCOMING} WHERE a.doctor_id = ANY($1::uuid[]) AND ${TODAY} ORDER BY a.start_at`, [ids]),
      ]);
      return { role: user.role, doctors, today, counts: ids.length ? await statusCounts("doctor_id", ids) : {} };
    }

    case "ADMIN": {
      const [pending, today, totals] = await Promise.all([
        queryOne<{ count: number }>(
          "SELECT count(*)::int AS count FROM app.doctor_profiles WHERE verification_status = 'PENDING'",
        ),
        queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM app.appointments a WHERE ${TODAY}`),
        queryOne(
          `SELECT (SELECT count(*) FROM auth.users WHERE role = 'PATIENT')::int AS patients,
                  (SELECT count(*) FROM app.doctor_profiles WHERE verification_status = 'APPROVED')::int AS doctors,
                  (SELECT count(*) FROM app.clinics)::int AS clinics,
                  (SELECT count(*) FROM app.appointments)::int AS appointments`,
        ),
      ]);
      return {
        role: user.role,
        pendingDoctorVerifications: pending?.count ?? 0,
        appointmentsToday: today?.count ?? 0,
        totals,
      };
    }
  }
}
