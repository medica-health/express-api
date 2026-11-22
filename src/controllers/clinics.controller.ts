import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import * as clinics from "../services/clinics.service";
import { created, ok } from "../utils/respond";
import type { ClinicBody, SearchClinicsQuery, UpdateClinicBody } from "../validators/clinics";

export async function search(_req: Request, res: Response) {
  ok(res, "Clinics fetched", await clinics.searchClinics(input<SearchClinicsQuery>(res, "query")));
}

export async function get(_req: Request, res: Response) {
  ok(res, "Clinic fetched", await clinics.getClinic(input<{ id: string }>(res, "params").id));
}

export async function create(req: Request, res: Response) {
  created(res, "Clinic created", await clinics.createClinic(currentUser(req), input<ClinicBody>(res, "body")));
}

export async function update(req: Request, res: Response) {
  const { id } = input<{ id: string }>(res, "params");
  ok(res, "Clinic updated", await clinics.updateClinic(currentUser(req), id, input<UpdateClinicBody>(res, "body")));
}

export async function remove(_req: Request, res: Response) {
  await clinics.deleteClinic(input<{ id: string }>(res, "params").id);
  ok(res, "Clinic deleted");
}
