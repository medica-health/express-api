import mongoose from "mongoose";
import { Readable } from "node:stream";
import { query, queryOne } from "../db";
import type { AuthUser } from "../types/auth";
import { AppError } from "../utils/AppError";
import { offsetOf, paged } from "../utils/pagination";
import type { ListRecordsQuery, UploadRecordBody } from "../validators/clinical";
import { hasTreated } from "./access.service";
import { audit } from "./audit.service";
import { assertCanViewClinical } from "./prescriptions.service";

export const MAX_RECORD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"];

// Magic-number check so a renamed file can't masquerade as an allowed type.
export function sniffMimeType(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

function bucket() {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) {
    throw new AppError(503, "File storage is temporarily unavailable");
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName: "medical_records" });
}

const RECORD_SELECT = `
  SELECT r.id, r.patient_id, r.uploaded_by, u.full_name AS uploaded_by_name, u.role AS uploaded_by_role,
         r.appointment_id, r.title, r.record_type, r.description, r.file_name, r.mime_type, r.size_bytes, r.created_at
    FROM app.medical_records r JOIN auth.users u ON u.id = r.uploaded_by`;

/** Patients upload their own records; doctors upload for patients they have treated. */
export async function uploadRecord(user: AuthUser, body: UploadRecordBody, file: Express.Multer.File | undefined) {
  if (!file) throw AppError.badRequest("A file is required (form field 'file')");
  const mime = sniffMimeType(file.buffer);
  if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) throw AppError.badRequest("Only PDF, PNG and JPEG files are allowed");

  let patientId = user.id;
  if (user.role === "DOCTOR") {
    if (!body.patientId) throw AppError.badRequest("patientId is required");
    if (!(await hasTreated(user.id, body.patientId))) throw AppError.forbidden("You have not treated this patient");
    patientId = body.patientId;
  }

  if (body.appointmentId) {
    const appt = await queryOne<{ patient_id: string }>("SELECT patient_id FROM app.appointments WHERE id = $1", [
      body.appointmentId,
    ]);
    if (!appt || appt.patient_id !== patientId) throw AppError.badRequest("Appointment does not belong to this patient");
  }

  const fileId = await new Promise<string>((resolve, reject) => {
    const upload = bucket().openUploadStream(file.originalname, {
      metadata: { patientId, uploadedBy: user.id, contentType: mime },
    });
    Readable.from(file.buffer)
      .pipe(upload)
      .on("error", reject)
      .on("finish", () => resolve(upload.id.toString()));
  });

  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO app.medical_records
         (patient_id, uploaded_by, appointment_id, title, record_type, description, file_name, mime_type, size_bytes, gridfs_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        patientId,
        user.id,
        body.appointmentId ?? null,
        body.title,
        body.recordType,
        body.description ?? null,
        file.originalname.slice(0, 255),
        mime,
        file.size,
        fileId,
      ],
    );
    audit(user, "RECORD_UPLOADED", "medical_record", row!.id, { patientId });
    return queryOne(`${RECORD_SELECT} WHERE r.id = $1`, [row!.id]);
  } catch (err) {
    // Don't leave an orphaned file behind if the metadata insert fails.
    await bucket().delete(new mongoose.Types.ObjectId(fileId)).catch(() => {});
    throw err;
  }
}

export async function listRecords(user: AuthUser, q: ListRecordsQuery) {
  const patientId = user.role === "PATIENT" ? user.id : q.patientId;
  if (!patientId) throw AppError.badRequest("patientId is required");
  await assertCanViewClinical(user, patientId);

  const params: unknown[] = [patientId];
  let filter = "";
  if (q.recordType) {
    params.push(q.recordType);
    filter = "AND r.record_type = $2";
  }
  const count = await queryOne<{ count: string }>(
    `SELECT count(*) FROM app.medical_records r WHERE r.patient_id = $1 ${filter}`,
    params,
  );
  const rows = await query(
    `${RECORD_SELECT} WHERE r.patient_id = $1 ${filter}
      ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, offsetOf(q)],
  );
  return paged(rows, Number(count?.count ?? 0), q);
}

async function loadRecord(user: AuthUser, id: string) {
  const record = await queryOne<{
    id: string;
    patient_id: string;
    uploaded_by: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    gridfs_file_id: string;
  }>("SELECT id, patient_id, uploaded_by, file_name, mime_type, size_bytes, gridfs_file_id FROM app.medical_records WHERE id = $1", [id]);
  if (!record) throw AppError.notFound("Record not found");
  await assertCanViewClinical(user, record.patient_id);
  return record;
}

export async function openRecordDownload(user: AuthUser, id: string) {
  const record = await loadRecord(user, id);
  const stream = bucket().openDownloadStream(new mongoose.Types.ObjectId(record.gridfs_file_id));
  audit(user, "RECORD_DOWNLOADED", "medical_record", id);
  return { record, stream };
}

/** The patient or the original uploader may delete a record. */
export async function deleteRecord(user: AuthUser, id: string) {
  const record = await loadRecord(user, id);
  if (user.id !== record.patient_id && user.id !== record.uploaded_by) throw AppError.forbidden();
  await query("DELETE FROM app.medical_records WHERE id = $1", [id]);
  await bucket()
    .delete(new mongoose.Types.ObjectId(record.gridfs_file_id))
    .catch((err: Error) => console.error("GridFS delete failed:", err.message));
  audit(user, "RECORD_DELETED", "medical_record", id);
}
