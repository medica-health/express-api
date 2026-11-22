import { z } from "zod";
import { latitude, longitude } from "../utils/geo";
import { paginationSchema } from "../utils/pagination";
import { hhmm, id, isoDate, isoDateTime, optionalText } from "./common";

export const searchDoctorsQuery = paginationSchema
  .extend({
    lat: latitude.optional(),
    lng: longitude.optional(),
    radiusKm: z.coerce.number().positive().max(100).default(10),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    pincode: z.string().trim().regex(/^\d{4,10}$/, "Invalid pincode").optional(),
    specializationId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    language: z.string().trim().min(1).max(50).optional(),
    minFee: z.coerce.number().nonnegative().optional(),
    maxFee: z.coerce.number().nonnegative().optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    sort: z.enum(["distance", "rating", "fee", "experience"]).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "lat and lng must be provided together",
    path: ["lat"],
  })
  .refine((v) => v.minFee === undefined || v.maxFee === undefined || v.minFee <= v.maxFee, {
    message: "minFee must be less than or equal to maxFee",
    path: ["minFee"],
  });
export type SearchDoctorsQuery = z.infer<typeof searchDoctorsQuery>;

export const doctorIdParam = z.object({ doctorId: z.union([z.literal("me"), id]) });

export const slotsQuery = z.object({
  date: isoDate,
  clinicId: id.optional(),
});

export const updateDoctorProfileBody = z.object({
  specializationId: z.number().int().positive().nullable().optional(),
  qualifications: optionalText(500),
  registrationNumber: optionalText(100),
  experienceYears: z.number().int().min(0).max(80).optional(),
  consultationFee: z.number().min(0).max(1_000_000).optional(),
  bio: optionalText(3000),
  languages: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});
export type UpdateDoctorProfileBody = z.infer<typeof updateDoctorProfileBody>;

// ---- availability
export const availabilityBody = z
  .object({
    clinicId: id,
    dayOfWeek: z.number().int().min(0).max(6), // 0 = Sunday
    startTime: hhmm,
    endTime: hhmm,
    slotMinutes: z.number().int().min(5).max(240).default(15),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.endTime > v.startTime, { message: "endTime must be after startTime", path: ["endTime"] });
export type AvailabilityBody = z.infer<typeof availabilityBody>;

export const availabilityItemParams = z.object({ doctorId: z.union([z.literal("me"), id]), id });

// ---- time off
export const timeOffBody = z
  .object({
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    reason: optionalText(300),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: "endsAt must be after startsAt", path: ["endsAt"] });
export type TimeOffBody = z.infer<typeof timeOffBody>;

export const timeOffQuery = z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() });

export const doctorClinicParams = z.object({ doctorId: z.union([z.literal("me"), id]), clinicId: id });
