import type { Response } from "express";

// Standard response envelope shared with spring-api: { success, message, data, timestamp }.
export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data?: T;
  timestamp: string;
}

export function envelope<T>(success: boolean, message: string, data?: T): ApiEnvelope<T> {
  const body: ApiEnvelope<T> = { success, message, timestamp: new Date().toISOString() };
  if (data !== undefined) body.data = data;
  return body;
}

export function ok<T>(res: Response, message: string, data?: T, status = 200) {
  return res.status(status).json(envelope(true, message, data));
}

export function created<T>(res: Response, message: string, data?: T) {
  return ok(res, message, data, 201);
}
