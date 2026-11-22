import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import { assertCanManageDoctor, resolveDoctorId } from "../services/access.service";
import * as doctors from "../services/doctors.service";
import * as reviews from "../services/reviews.service";
import * as schedule from "../services/schedule.service";
import { created, ok } from "../utils/respond";
import type { Pagination } from "../utils/pagination";
import type { AvailabilityBody, SearchDoctorsQuery, TimeOffBody, UpdateDoctorProfileBody } from "../validators/doctors";

type DoctorParam = { doctorId: string };
type ItemParam = { doctorId: string; id: string };
type ClinicParam = { doctorId: string; clinicId: string };

/** Resolves :doctorId ("me" allowed) and checks the caller may manage that doctor. */
async function managedDoctor(req: Request, res: Response): Promise<string> {
  const user = currentUser(req);
  const doctorId = resolveDoctorId(input<DoctorParam>(res, "params").doctorId, user);
  await assertCanManageDoctor(user, doctorId);
  return doctorId;
}

// ---- public
export async function search(req: Request, res: Response) {
  const data = await doctors.searchDoctors(input<SearchDoctorsQuery>(res, "query"), req.user);
  ok(res, "Doctors fetched", data);
}

export async function details(req: Request, res: Response) {
  const { doctorId } = input<DoctorParam>(res, "params");
  ok(res, "Doctor fetched", await doctors.getDoctorDetails(doctorId, req.user));
}

export async function slots(req: Request, res: Response) {
  const { doctorId } = input<DoctorParam>(res, "params");
  const { date, clinicId } = input<{ date: string; clinicId?: string }>(res, "query");
  ok(res, "Available slots fetched", await doctors.availableSlots(doctorId, date, clinicId, req.user));
}

export async function listReviews(_req: Request, res: Response) {
  const { doctorId } = input<DoctorParam>(res, "params");
  ok(res, "Reviews fetched", await reviews.listDoctorReviews(doctorId, input<Pagination>(res, "query")));
}

// ---- own profile (doctor)
export async function getMyProfile(req: Request, res: Response) {
  ok(res, "Profile fetched", await doctors.getOwnProfile(currentUser(req).id));
}

export async function updateMyProfile(req: Request, res: Response) {
  const data = await doctors.updateProfile(currentUser(req).id, input<UpdateDoctorProfileBody>(res, "body"));
  ok(res, "Profile updated", data);
}

// ---- clinics linked to a doctor
export async function listClinics(req: Request, res: Response) {
  ok(res, "Clinics fetched", await doctors.clinicsOfDoctor(await managedDoctor(req, res)));
}

export async function linkClinic(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  const { clinicId } = input<ClinicParam>(res, "params");
  ok(res, "Clinic linked", await doctors.linkClinic(doctorId, clinicId));
}

export async function unlinkClinic(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  const { clinicId } = input<ClinicParam>(res, "params");
  ok(res, "Clinic unlinked", await doctors.unlinkClinic(doctorId, clinicId));
}

// ---- availability
export async function listAvailability(req: Request, res: Response) {
  ok(res, "Availability fetched", await schedule.listAvailability(await managedDoctor(req, res)));
}

export async function createAvailability(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  created(res, "Availability created", await schedule.createAvailability(doctorId, input<AvailabilityBody>(res, "body")));
}

export async function updateAvailability(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  const { id } = input<ItemParam>(res, "params");
  ok(res, "Availability updated", await schedule.updateAvailability(doctorId, id, input<AvailabilityBody>(res, "body")));
}

export async function deleteAvailability(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  await schedule.deleteAvailability(doctorId, input<ItemParam>(res, "params").id);
  ok(res, "Availability deleted");
}

// ---- time off
export async function listTimeOff(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  const { from, to } = input<{ from?: Date; to?: Date }>(res, "query");
  ok(res, "Time off fetched", await schedule.listTimeOff(doctorId, from, to));
}

export async function createTimeOff(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  created(res, "Time off added", await schedule.createTimeOff(doctorId, input<TimeOffBody>(res, "body")));
}

export async function deleteTimeOff(req: Request, res: Response) {
  const doctorId = await managedDoctor(req, res);
  await schedule.deleteTimeOff(doctorId, input<ItemParam>(res, "params").id);
  ok(res, "Time off removed");
}
