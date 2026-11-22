import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import * as admin from "../services/admin.service";
import { listAuditLogs } from "../services/audit.service";
import { dashboardFor } from "../services/dashboard.service";
import { deleteReview } from "../services/reviews.service";
import { created, ok } from "../utils/respond";
import type { AdminDoctorsQuery, VerificationBody } from "../validators/admin";

export async function listDoctors(_req: Request, res: Response) {
  ok(res, "Doctors fetched", await admin.listDoctorsForAdmin(input<AdminDoctorsQuery>(res, "query")));
}

export async function verifyDoctor(req: Request, res: Response) {
  const { id } = input<{ id: string }>(res, "params");
  ok(res, "Verification updated", await admin.setVerification(currentUser(req), id, input<VerificationBody>(res, "body")));
}

export async function listSpecializations(_req: Request, res: Response) {
  ok(res, "Specializations fetched", await admin.listSpecializations());
}

export async function createSpecialization(req: Request, res: Response) {
  const { name, description } = input<{ name: string; description?: string }>(res, "body");
  created(res, "Specialization created", await admin.createSpecialization(currentUser(req), name, description));
}

export async function updateSpecialization(req: Request, res: Response) {
  const { id } = input<{ id: number }>(res, "params");
  const { name, description } = input<{ name: string; description?: string }>(res, "body");
  ok(res, "Specialization updated", await admin.updateSpecialization(currentUser(req), id, name, description));
}

export async function deleteSpecialization(req: Request, res: Response) {
  await admin.deleteSpecialization(currentUser(req), input<{ id: number }>(res, "params").id);
  ok(res, "Specialization deleted");
}

export async function listAssignments(_req: Request, res: Response) {
  ok(res, "Assignments fetched", await admin.listAssignments(input<{ receptionistId?: string; doctorId?: string }>(res, "query")));
}

export async function createAssignment(req: Request, res: Response) {
  const { receptionistId, doctorId } = input<{ receptionistId: string; doctorId: string }>(res, "body");
  created(res, "Receptionist assigned", await admin.createAssignment(currentUser(req), receptionistId, doctorId));
}

export async function deleteAssignment(req: Request, res: Response) {
  const { receptionistId, doctorId } = input<{ receptionistId: string; doctorId: string }>(res, "body");
  await admin.deleteAssignment(currentUser(req), receptionistId, doctorId);
  ok(res, "Assignment removed");
}

export async function stats(_req: Request, res: Response) {
  ok(res, "Stats fetched", await admin.platformStats());
}

export async function removeReview(req: Request, res: Response) {
  await deleteReview(currentUser(req), input<{ id: string }>(res, "params").id);
  ok(res, "Review deleted");
}

export async function auditLogs(_req: Request, res: Response) {
  const { limit, ...filter } = input<{ entityId?: string; actorId?: string; action?: string; limit: number }>(res, "query");
  ok(res, "Audit logs fetched", await listAuditLogs(filter, limit));
}

export async function dashboard(req: Request, res: Response) {
  ok(res, "Dashboard fetched", await dashboardFor(currentUser(req)));
}
