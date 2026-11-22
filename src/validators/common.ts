import { z } from "zod";

export const id = z.guid("Must be a valid id");
export const idParam = z.object({ id });
export const isoDate = z.iso.date(); // YYYY-MM-DD
export const isoDateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
export const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be a time in HH:MM (24h) format");

export const optionalText = (max: number) => z.string().trim().max(max).optional();
