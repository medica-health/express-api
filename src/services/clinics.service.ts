import { query, queryOne, withTransaction } from "../db";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { LAT_LNG_SQL, POINT_SQL } from "../utils/geo";
import { offsetOf, paged } from "../utils/pagination";
import { SqlBuilder } from "../utils/sql";
import type { ClinicBody, SearchClinicsQuery, UpdateClinicBody } from "../validators/clinics";
import { ensureDoctorProfile } from "./doctors.service";

const CLINIC_COLUMNS = `c.id, c.name, c.address_line, c.city, c.state, c.pincode, c.country, c.phone,
  c.timezone, ${LAT_LNG_SQL("c.location")}, c.created_by, c.created_at, c.updated_at`;

export async function getClinic(id: string) {
  const clinic = await queryOne(`SELECT ${CLINIC_COLUMNS} FROM app.clinics c WHERE c.id = $1`, [id]);
  if (!clinic) throw AppError.notFound("Clinic not found");
  const doctors = await query(
    `SELECT dp.user_id AS id, u.full_name AS name, s.name::text AS specialization,
            dp.avg_rating::float AS avg_rating, dp.consultation_fee::float AS consultation_fee
       FROM app.doctor_clinics dc
       JOIN app.doctor_profiles dp ON dp.user_id = dc.doctor_id AND dp.verification_status = 'APPROVED'
       JOIN auth.users u ON u.id = dp.user_id AND u.enabled
       LEFT JOIN app.specializations s ON s.id = dp.specialization_id
      WHERE dc.clinic_id = $1 ORDER BY u.full_name`,
    [id],
  );
  return { ...clinic, doctors };
}

export async function searchClinics(q: SearchClinicsQuery) {
  const b = new SqlBuilder();
  let distance = "NULL::float";
  if (q.lat !== undefined && q.lng !== undefined) {
    const point = POINT_SQL(b.param(q.lng), b.param(q.lat));
    distance = `ST_Distance(c.location, ${point}) / 1000.0`;
    b.where(`ST_DWithin(c.location, ${point}, ${b.param(q.radiusKm * 1000)})`);
  }
  if (q.city) b.where(`lower(c.city) = lower(${b.param(q.city)})`);
  if (q.q) b.where(`c.name ILIKE ${b.param(`%${q.q}%`)}`);

  const rows = await query<Record<string, unknown> & { total: string }>(
    `SELECT ${CLINIC_COLUMNS}, ${distance} AS distance_km, count(*) OVER () AS total
       FROM app.clinics c ${b.whereClause()}
      ORDER BY distance_km ASC NULLS LAST, c.name
      LIMIT ${b.param(q.limit)} OFFSET ${b.param(offsetOf(q))}`,
    b.params,
  );
  const total = rows[0] ? Number(rows[0].total) : 0;
  return paged(rows.map(({ total: _t, ...r }) => r), total, q);
}

/** Doctors create clinics they practise at (auto-linked); admins create clinics for anyone. */
export async function createClinic(user: AuthUser, body: ClinicBody) {
  return withTransaction(async (tx) => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO app.clinics (name, address_line, city, state, pincode, country, phone, timezone, location, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${POINT_SQL("$9", "$10")}, $11)
       RETURNING id`,
      [
        body.name,
        body.addressLine,
        body.city,
        body.state,
        body.pincode,
        body.country,
        body.phone ?? null,
        body.timezone,
        body.lng,
        body.lat,
        user.id,
      ],
      tx,
    );
    if (user.role === "DOCTOR") {
      await ensureDoctorProfile(user.id, tx);
      await query("INSERT INTO app.doctor_clinics (doctor_id, clinic_id) VALUES ($1, $2)", [user.id, row!.id], tx);
    }
    return row!.id;
  }).then(getClinic);
}

export async function updateClinic(user: AuthUser, id: string, body: UpdateClinicBody) {
  const clinic = await queryOne<{ created_by: string }>("SELECT created_by FROM app.clinics WHERE id = $1", [id]);
  if (!clinic) throw AppError.notFound("Clinic not found");
  if (user.role !== "ADMIN" && clinic.created_by !== user.id) {
    throw AppError.forbidden("Only the clinic's creator or an admin can edit it");
  }

  const columns: Record<string, unknown> = {
    name: body.name,
    address_line: body.addressLine,
    city: body.city,
    state: body.state,
    pincode: body.pincode,
    country: body.country,
    phone: body.phone,
    timezone: body.timezone,
  };
  const b = new SqlBuilder();
  const sets: string[] = [];
  for (const [col, value] of Object.entries(columns)) {
    if (value !== undefined) sets.push(`${col} = ${b.param(value)}`);
  }
  if (body.lat !== undefined && body.lng !== undefined) {
    sets.push(`location = ${POINT_SQL(b.param(body.lng), b.param(body.lat))}`);
  }
  if (sets.length) {
    await query(`UPDATE app.clinics SET ${sets.join(", ")}, updated_at = now() WHERE id = ${b.param(id)}`, b.params);
  }
  return getClinic(id);
}

export async function deleteClinic(id: string) {
  const inUse = await queryOne("SELECT 1 FROM app.appointments WHERE clinic_id = $1 LIMIT 1", [id]);
  if (inUse) throw AppError.conflict("Clinic has appointments and cannot be deleted");
  const deleted = await queryOne("DELETE FROM app.clinics WHERE id = $1 RETURNING id", [id]);
  if (!deleted) throw AppError.notFound("Clinic not found");
}
