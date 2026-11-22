import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function offsetOf(p: Pagination): number {
  return (p.page - 1) * p.limit;
}

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function paged<T>(items: T[], total: number, p: Pagination): Paged<T> {
  return { items, page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) };
}
