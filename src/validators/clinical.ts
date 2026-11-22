import { z } from "zod";
import { paginationSchema } from "../utils/pagination";
import { id, isoDate, optionalText } from "./common";

// ---- prescriptions
const prescriptionItem = z.object({
  medicine: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(100), // e.g. "500 mg"
  frequency: z.string().trim().min(1).max(100), // e.g. "1-0-1 after food"
  duration: z.string().trim().min(1).max(100), // e.g. "5 days"
  instructions: optionalText(500),
});

export const prescriptionBody = z.object({
  diagnosis: z.string().trim().min(2).max(2000),
  notes: optionalText(5000),
  advice: optionalText(2000),
  followUpDate: isoDate.optional(),
  items: z.array(prescriptionItem).max(50).default([]),
});
export type PrescriptionBody = z.infer<typeof prescriptionBody>;

export const appointmentIdParam = z.object({ appointmentId: id });
export const patientIdParam = z.object({ patientId: z.union([z.literal("me"), id]) });

// ---- medical records (multipart form fields, so everything arrives as strings)
export const RECORD_TYPES = ["LAB_REPORT", "IMAGING", "PRESCRIPTION", "DISCHARGE_SUMMARY", "OTHER"] as const;

export const uploadRecordBody = z.object({
  title: z.string().trim().min(2).max(200),
  recordType: z.enum(RECORD_TYPES).default("OTHER"),
  description: optionalText(1000),
  appointmentId: id.optional(),
  patientId: id.optional(), // required when a doctor uploads for a patient
});
export type UploadRecordBody = z.infer<typeof uploadRecordBody>;

export const listRecordsQuery = paginationSchema.extend({
  patientId: id.optional(),
  recordType: z.enum(RECORD_TYPES).optional(),
});
export type ListRecordsQuery = z.infer<typeof listRecordsQuery>;

// ---- reviews
export const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  comment: optionalText(2000),
});
export type ReviewBody = z.infer<typeof reviewBody>;

export const patientLookupQuery = z.object({ email: z.email() });

export const updatePatientProfileBody = z.object({
  dateOfBirth: isoDate.nullable().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable().optional(),
  bloodGroup: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable().optional(),
  allergies: optionalText(1000),
  chronicConditions: optionalText(1000),
  addressLine: optionalText(300),
  city: optionalText(100),
  state: optionalText(100),
  pincode: optionalText(10),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  emergencyContactName: optionalText(200),
  emergencyContactPhone: optionalText(20),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), {
  message: "lat and lng must be updated together",
  path: ["lat"],
});
export type UpdatePatientProfileBody = z.infer<typeof updatePatientProfileBody>;
