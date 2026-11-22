import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { isProduction } from "../config/env";
import { AppError } from "../utils/AppError";
import { envelope } from "../utils/respond";

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

// Friendly messages for constraint violations raised by Postgres.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  appointments_doctor_no_overlap: "This time slot is no longer available",
  appointments_patient_no_overlap: "The patient already has an appointment at this time",
  doctor_availability_no_overlap: "This availability overlaps an existing slot on the same day",
  reviews_appointment_id_key: "This appointment has already been reviewed",
  prescriptions_appointment_id_key: "A prescription already exists for this appointment",
  specializations_name_key: "A specialization with this name already exists",
};

export function notFound(_req: Request, res: Response) {
  res.status(404).json(envelope(false, "Route not found"));
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json(envelope(false, err.message, err.details));
  }

  if (err instanceof ZodError) {
    const details: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      details[key] ??= issue.message;
    }
    return res.status(400).json(envelope(false, "Validation failed", details));
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 10 MB)" : err.message;
    return res.status(400).json(envelope(false, message));
  }

  // body-parser JSON syntax errors
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json(envelope(false, "Malformed JSON body"));
  }

  const pg = err as PgError;
  if (pg?.code === "23505" || pg?.code === "23P01") {
    const message = (pg.constraint && CONSTRAINT_MESSAGES[pg.constraint]) || "Resource already exists";
    return res.status(409).json(envelope(false, message));
  }
  if (pg?.code === "23503") {
    return res.status(400).json(envelope(false, "Referenced resource does not exist"));
  }
  if (pg?.code === "22P02") {
    return res.status(400).json(envelope(false, "Invalid identifier format"));
  }

  console.error("Unhandled error:", err);
  const message = isProduction ? "Internal server error" : (err as Error)?.message || "Internal server error";
  return res.status(500).json(envelope(false, message));
}
