import { z } from "zod";
import { APPOINTMENT_STATUSES } from "../policies/appointmentStatus";
import { paginationSchema } from "../utils/pagination";
import { id, isoDateTime, optionalText } from "./common";

export const bookAppointmentBody = z.object({
  doctorId: id,
  clinicId: id,
  startAt: isoDateTime,
  reason: optionalText(1000),
  // Required when a receptionist or admin books on behalf of a patient; ignored for patients.
  patientId: id.optional(),
});
export type BookAppointmentBody = z.infer<typeof bookAppointmentBody>;

// Temporarily hold a slot while the patient confirms (Redis). Same slot rules as booking.
export const holdSlotBody = z.object({
  doctorId: id,
  clinicId: id,
  startAt: isoDateTime,
});
export type HoldSlotBody = z.infer<typeof holdSlotBody>;

export const holdIdParam = z.object({ holdId: id });

export const listAppointmentsQuery = paginationSchema.extend({
  status: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()))
    .pipe(z.array(z.enum(APPOINTMENT_STATUSES)))
    .optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  doctorId: id.optional(),
  patientId: id.optional(),
  clinicId: id.optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuery>;

export const updateStatusBody = z.object({
  status: z.enum(["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"]),
  doctorNotes: optionalText(5000),
});
export type UpdateStatusBody = z.infer<typeof updateStatusBody>;

export const cancelBody = z.object({ reason: optionalText(500) });

export const rescheduleBody = z.object({
  startAt: isoDateTime,
  clinicId: id.optional(), // defaults to the current clinic
});
export type RescheduleBody = z.infer<typeof rescheduleBody>;
