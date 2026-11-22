import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import * as patients from "../services/patients.service";
import * as prescriptions from "../services/prescriptions.service";
import { AppError } from "../utils/AppError";
import type { Pagination } from "../utils/pagination";
import { ok } from "../utils/respond";
import type { UpdatePatientProfileBody } from "../validators/clinical";

/** Resolves :patientId, where "me" means the calling patient. */
function patientIdOf(req: Request, res: Response): string {
  const { patientId } = input<{ patientId: string }>(res, "params");
  if (patientId !== "me") return patientId;
  const user = currentUser(req);
  if (user.role !== "PATIENT") throw AppError.badRequest("'me' can only be used by patients");
  return user.id;
}

export async function getMyProfile(req: Request, res: Response) {
  ok(res, "Profile fetched", await patients.getProfile(currentUser(req).id));
}

export async function updateMyProfile(req: Request, res: Response) {
  const data = await patients.updateProfile(currentUser(req).id, input<UpdatePatientProfileBody>(res, "body"));
  ok(res, "Profile updated", data);
}

export async function lookup(req: Request, res: Response) {
  const { email } = input<{ email: string }>(res, "query");
  ok(res, "Patient found", await patients.lookupPatientByEmail(currentUser(req), email));
}

export async function myPatients(req: Request, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
  ok(res, "Patients fetched", await patients.listMyPatients(currentUser(req), q));
}

export async function summary(req: Request, res: Response) {
  ok(res, "Patient summary fetched", await patients.getPatientSummary(currentUser(req), patientIdOf(req, res)));
}

export async function prescriptionsOf(req: Request, res: Response) {
  const data = await prescriptions.listPatientPrescriptions(
    currentUser(req),
    patientIdOf(req, res),
    input<Pagination>(res, "query"),
  );
  ok(res, "Prescriptions fetched", data);
}

export async function getPrescription(req: Request, res: Response) {
  const { id } = input<{ id: string }>(res, "params");
  ok(res, "Prescription fetched", await prescriptions.getPrescriptionById(currentUser(req), id));
}
