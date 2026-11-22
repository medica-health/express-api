import { z } from "zod";
import { latitude, longitude } from "../utils/geo";
import { paginationSchema } from "../utils/pagination";
import { optionalText } from "./common";

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown IANA time zone" },
);

export const clinicBody = z.object({
  name: z.string().trim().min(2).max(200),
  addressLine: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  pincode: z.string().trim().regex(/^\d{4,10}$/, "Invalid pincode"),
  country: z.string().trim().min(2).max(100).default("India"),
  phone: optionalText(20),
  timezone: timezone.default("Asia/Kolkata"),
  lat: latitude,
  lng: longitude,
});
export type ClinicBody = z.infer<typeof clinicBody>;

export const updateClinicBody = clinicBody.partial().refine(
  (v) => (v.lat === undefined) === (v.lng === undefined),
  { message: "lat and lng must be updated together", path: ["lat"] },
);
export type UpdateClinicBody = z.infer<typeof updateClinicBody>;

export const searchClinicsQuery = paginationSchema
  .extend({
    lat: latitude.optional(),
    lng: longitude.optional(),
    radiusKm: z.coerce.number().positive().max(100).default(10),
    city: z.string().trim().min(1).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "lat and lng must be provided together",
    path: ["lat"],
  });
export type SearchClinicsQuery = z.infer<typeof searchClinicsQuery>;
