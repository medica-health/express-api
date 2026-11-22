import { z } from "zod";
import { paginationSchema } from "../utils/pagination";
import { id, optionalText } from "./common";

export const adminDoctorsQuery = paginationSchema.extend({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type AdminDoctorsQuery = z.infer<typeof adminDoctorsQuery>;

export const verificationBody = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    reason: optionalText(1000),
  })
  .refine((v) => v.status !== "REJECTED" || !!v.reason, {
    message: "A reason is required when rejecting",
    path: ["reason"],
  });
export type VerificationBody = z.infer<typeof verificationBody>;

export const specializationBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: optionalText(500),
});
export const specializationIdParam = z.object({ id: z.coerce.number().int().positive() });

export const assignmentBody = z.object({ receptionistId: id, doctorId: id });
export const assignmentsQuery = z.object({ receptionistId: id.optional(), doctorId: id.optional() });

export const auditQuery = z.object({
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
