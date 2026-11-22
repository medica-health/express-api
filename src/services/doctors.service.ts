import { query, queryOne, type Queryable } from "../db";
import { filterAvailableSlots, type Interval, type Slot } from "../policies/slots";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { LAT_LNG_SQL, POINT_SQL } from "../utils/geo";
import { offsetOf, paged } from "../utils/pagination";
import { SqlBuilder } from "../utils/sql";
import type { SearchDoctorsQuery, UpdateDoctorProfileBody } from "../validators/doctors";

// ------------------------------------------------------------------ profile

/** Creates the doctor's profile row on first use (doctor accounts are created in spring-api). */
export async function ensureDoctorProfile(doctorId: string, db?: Queryable): Promise<void> {
  await query(
    "INSERT INTO app.doctor_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [doctorId],
    db,
  );
}

const PROFILE_SELECT = `
  SELECT dp.user_id AS id, u.full_name AS name, u.email::text AS email, u.phone,
         dp.specialization_id, s.name::text AS specialization,
         dp.qualifications, dp.registration_number, dp.experience_years,
         dp.consultation_fee::float AS consultation_fee, dp.bio, dp.languages,
         dp.verification_status, dp.rejection_reason, dp.verified_at,
         dp.avg_rating::float AS avg_rating, dp.rating_count, dp.created_at, dp.updated_at
    FROM app.doctor_profiles dp
    JOIN auth.users u ON u.id = dp.user_id
    LEFT JOIN app.specializations s ON s.id = dp.specialization_id`;

export async function getOwnProfile(doctorId: string) {
  await ensureDoctorProfile(doctorId);
  const profile = await queryOne(`${PROFILE_SELECT} WHERE dp.user_id = $1`, [doctorId]);
  const clinics = await clinicsOfDoctor(doctorId);
  return { ...profile, clinics };
}

export async function updateProfile(doctorId: string, body: UpdateDoctorProfileBody) {
  await ensureDoctorProfile(doctorId);
  const fields: Record<string, unknown> = {
    specialization_id: body.specializationId,
    qualifications: body.qualifications,
    registration_number: body.registrationNumber,
    experience_years: body.experienceYears,
    consultation_fee: body.consultationFee,
    bio: body.bio,
    languages: body.languages,
  };
  const sets: string[] = [];
  const params: unknown[] = [doctorId];
  for (const [col, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    // A rejected doctor who edits their profile goes back into the verification queue.
    await query(
      `UPDATE app.doctor_profiles
          SET ${sets.join(", ")}, updated_at = now(),
              verification_status = CASE WHEN verification_status = 'REJECTED' THEN 'PENDING' ELSE verification_status END
        WHERE user_id = $1`,
      params,
    );
  }
  return getOwnProfile(doctorId);
}

// ------------------------------------------------------------------ public search (PostGIS)

export async function searchDoctors(q: SearchDoctorsQuery, viewer?: AuthUser) {
  const b = new SqlBuilder();
  b.where("dp.verification_status = 'APPROVED'").where("u.enabled");

  // Fall back to the patient's saved location when no coordinates or place filter were given.
  let lat = q.lat;
  let lng = q.lng;
  if (lat === undefined && !q.city && !q.state && !q.pincode && viewer?.role === "PATIENT") {
    const saved = await queryOne<{ lat: number; lng: number }>(
      `SELECT ${LAT_LNG_SQL("location")} FROM app.patient_profiles WHERE user_id = $1 AND location IS NOT NULL`,
      [viewer.id],
    );
    if (saved) ({ lat, lng } = saved);
  }

  const geo = lat !== undefined && lng !== undefined;
  let distanceExpr = "NULL::float";
  if (geo) {
    const point = POINT_SQL(b.param(lng), b.param(lat));
    distanceExpr = `ST_Distance(c.location, ${point}) / 1000.0`;
    b.where(`ST_DWithin(c.location, ${point}, ${b.param(q.radiusKm * 1000)})`);
  }
  if (q.city) b.where(`lower(c.city) = lower(${b.param(q.city)})`);
  if (q.state) b.where(`lower(c.state) = lower(${b.param(q.state)})`);
  if (q.pincode) b.where(`c.pincode = ${b.param(q.pincode)}`);
  if (q.specializationId) b.where(`dp.specialization_id = ${b.param(q.specializationId)}`);
  if (q.minFee !== undefined) b.where(`dp.consultation_fee >= ${b.param(q.minFee)}`);
  if (q.maxFee !== undefined) b.where(`dp.consultation_fee <= ${b.param(q.maxFee)}`);
  if (q.minRating !== undefined) b.where(`dp.avg_rating >= ${b.param(q.minRating)}`);
  if (q.language) b.where(`${b.param(q.language)} ILIKE ANY (dp.languages)`);
  if (q.q) {
    const term = b.param(`%${q.q}%`);
    b.where(`(u.full_name ILIKE ${term} OR s.name ILIKE ${term} OR c.name ILIKE ${term})`);
  }

  const sort = q.sort ?? (geo ? "distance" : "rating");
  const orderBy = {
    distance: geo ? "distance_km ASC, avg_rating DESC" : "avg_rating DESC, rating_count DESC",
    rating: "avg_rating DESC, rating_count DESC",
    fee: "consultation_fee ASC",
    experience: "experience_years DESC",
  }[sort];

  const limit = b.param(q.limit);
  const offset = b.param(offsetOf(q));

  // DISTINCT ON keeps one row per doctor: the nearest matching clinic.
  const rows = await query<Record<string, unknown> & { total: string }>(
    `WITH matches AS (
       SELECT DISTINCT ON (dp.user_id)
              dp.user_id AS id, u.full_name AS name, s.id AS specialization_id, s.name::text AS specialization,
              dp.qualifications, dp.experience_years, dp.consultation_fee::float AS consultation_fee,
              dp.languages, dp.avg_rating::float AS avg_rating, dp.rating_count,
              c.id AS clinic_id, c.name AS clinic_name, c.address_line AS clinic_address,
              c.city AS clinic_city, c.state AS clinic_state, c.pincode AS clinic_pincode,
              ${LAT_LNG_SQL("c.location")},
              ${distanceExpr} AS distance_km
         FROM app.doctor_profiles dp
         JOIN auth.users u ON u.id = dp.user_id
         LEFT JOIN app.specializations s ON s.id = dp.specialization_id
         JOIN app.doctor_clinics dc ON dc.doctor_id = dp.user_id
         JOIN app.clinics c ON c.id = dc.clinic_id
         ${b.whereClause()}
        ORDER BY dp.user_id, distance_km ASC NULLS LAST
     )
     SELECT *, count(*) OVER () AS total FROM matches
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    b.params,
  );

  const total = rows[0] ? Number(rows[0].total) : 0;
  const items = rows.map(({ total: _t, distance_km, lat: cLat, lng: cLng, ...r }) => ({
    id: r.id,
    name: r.name,
    specialization: r.specialization,
    specializationId: r.specialization_id,
    qualifications: r.qualifications,
    experienceYears: r.experience_years,
    consultationFee: r.consultation_fee,
    languages: r.languages,
    avgRating: r.avg_rating,
    ratingCount: r.rating_count,
    distanceKm: distance_km === null ? null : Math.round(Number(distance_km) * 10) / 10,
    nearestClinic: {
      id: r.clinic_id,
      name: r.clinic_name,
      address: r.clinic_address,
      city: r.clinic_city,
      state: r.clinic_state,
      pincode: r.clinic_pincode,
      lat: cLat,
      lng: cLng,
    },
  }));
  return { ...paged(items, total, q), searchCenter: geo ? { lat, lng, radiusKm: q.radiusKm } : null };
}

export async function clinicsOfDoctor(doctorId: string, db?: Queryable) {
  return query(
    `SELECT c.id, c.name, c.address_line, c.city, c.state, c.pincode, c.country, c.phone, c.timezone,
            ${LAT_LNG_SQL("c.location")}
       FROM app.doctor_clinics dc JOIN app.clinics c ON c.id = dc.clinic_id
      WHERE dc.doctor_id = $1 ORDER BY c.name`,
    [doctorId],
    db,
  );
}

/** Public doctor page. Unapproved doctors are only visible to themselves and admins. */
export async function getDoctorDetails(doctorId: string, viewer?: AuthUser) {
  const profile = await queryOne<{ verification_status: string }>(`${PROFILE_SELECT} WHERE dp.user_id = $1`, [
    doctorId,
  ]);
  const privileged = viewer && (viewer.role === "ADMIN" || viewer.id === doctorId);
  if (!profile || (profile.verification_status !== "APPROVED" && !privileged)) {
    throw AppError.notFound("Doctor not found");
  }
  const clinics = await clinicsOfDoctor(doctorId);
  if (!privileged) {
    const { email: _e, phone: _p, rejection_reason: _r, ...rest } = profile as Record<string, unknown>;
    return { ...rest, clinics };
  }
  return { ...profile, clinics };
}

// ------------------------------------------------------------------ slots

interface CandidateRow {
  start_at: Date;
  end_at: Date;
  clinic_id: string;
}

/**
 * Generates bookable slots for a doctor on a calendar date (interpreted in each clinic's
 * time zone) from the weekly availability rules.
 */
export async function candidateSlots(
  doctorId: string,
  date: string,
  clinicId: string | undefined,
  db?: Queryable,
): Promise<Slot[]> {
  const rows = await query<CandidateRow>(
    `SELECT gs AS start_at, gs + make_interval(mins => a.slot_minutes) AS end_at, a.clinic_id
       FROM app.doctor_availability a
       JOIN app.clinics c ON c.id = a.clinic_id
       JOIN app.doctor_clinics dc ON dc.doctor_id = a.doctor_id AND dc.clinic_id = a.clinic_id
      CROSS JOIN LATERAL generate_series(
              ($2::date + a.start_time) AT TIME ZONE c.timezone,
              ($2::date + a.end_time) AT TIME ZONE c.timezone - make_interval(mins => a.slot_minutes),
              make_interval(mins => a.slot_minutes)) AS gs
      WHERE a.doctor_id = $1
        AND a.is_active
        AND a.day_of_week = extract(dow FROM $2::date)
        AND ($3::uuid IS NULL OR a.clinic_id = $3)`,
    [doctorId, date, clinicId ?? null],
    db,
  );
  return rows.map((r) => ({ startAt: r.start_at, endAt: r.end_at, clinicId: r.clinic_id }));
}

/** Appointments and time off overlapping [from, to). Optionally ignores one appointment (reschedule). */
export async function busyIntervals(
  doctorId: string,
  from: Date,
  to: Date,
  db?: Queryable,
  excludeAppointmentId?: string,
): Promise<Interval[]> {
  const rows = await query<{ start_at: Date; end_at: Date }>(
    `SELECT start_at, end_at FROM app.appointments
      WHERE doctor_id = $1 AND status NOT IN ('CANCELLED', 'NO_SHOW')
        AND start_at < $3 AND end_at > $2 AND ($4::uuid IS NULL OR id <> $4)
     UNION ALL
     SELECT starts_at, ends_at FROM app.doctor_time_off
      WHERE doctor_id = $1 AND starts_at < $3 AND ends_at > $2`,
    [doctorId, from, to, excludeAppointmentId ?? null],
    db,
  );
  return rows.map((r) => ({ startAt: r.start_at, endAt: r.end_at }));
}

export async function availableSlots(doctorId: string, date: string, clinicId?: string) {
  const doctor = await queryOne<{ verification_status: string }>(
    "SELECT verification_status FROM app.doctor_profiles WHERE user_id = $1",
    [doctorId],
  );
  if (!doctor || doctor.verification_status !== "APPROVED") throw AppError.notFound("Doctor not found");

  const candidates = await candidateSlots(doctorId, date, clinicId);
  if (!candidates.length) return [];
  const from = new Date(Math.min(...candidates.map((s) => s.startAt.getTime())));
  const to = new Date(Math.max(...candidates.map((s) => s.endAt.getTime())));
  const busy = await busyIntervals(doctorId, from, to);
  return filterAvailableSlots(candidates, busy);
}

/** Admin/doctor: link or unlink a doctor and a clinic. */
export async function linkClinic(doctorId: string, clinicId: string) {
  await ensureDoctorProfile(doctorId);
  const clinic = await queryOne("SELECT 1 FROM app.clinics WHERE id = $1", [clinicId]);
  if (!clinic) throw AppError.notFound("Clinic not found");
  await query(
    "INSERT INTO app.doctor_clinics (doctor_id, clinic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [doctorId, clinicId],
  );
  return clinicsOfDoctor(doctorId);
}

export async function unlinkClinic(doctorId: string, clinicId: string) {
  const upcoming = await queryOne(
    `SELECT 1 FROM app.appointments
      WHERE doctor_id = $1 AND clinic_id = $2 AND start_at > now() AND status IN ('BOOKED', 'CONFIRMED')
      LIMIT 1`,
    [doctorId, clinicId],
  );
  if (upcoming) throw AppError.conflict("Cancel or move upcoming appointments at this clinic first");
  await query("DELETE FROM app.doctor_availability WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]);
  await query("DELETE FROM app.doctor_clinics WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]);
  return clinicsOfDoctor(doctorId);
}
