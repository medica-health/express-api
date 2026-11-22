import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import * as appointments from "../services/appointments.service";
import * as prescriptions from "../services/prescriptions.service";
import * as reviews from "../services/reviews.service";
import { created, ok } from "../utils/respond";
import type {
  BookAppointmentBody,
  ListAppointmentsQuery,
  RescheduleBody,
  UpdateStatusBody,
} from "../validators/appointments";
import type { PrescriptionBody, ReviewBody } from "../validators/clinical";

const idOf = (res: Response) => input<{ id: string }>(res, "params").id;
const apptIdOf = (res: Response) => input<{ appointmentId: string }>(res, "params").appointmentId;

export async function book(req: Request, res: Response) {
  const data = await appointments.bookAppointment(currentUser(req), input<BookAppointmentBody>(res, "body"));
  created(res, "Appointment booked", data);
}

export async function list(req: Request, res: Response) {
  ok(res, "Appointments fetched", await appointments.listAppointments(currentUser(req), input<ListAppointmentsQuery>(res, "query")));
}

export async function get(req: Request, res: Response) {
  ok(res, "Appointment fetched", await appointments.getAppointment(currentUser(req), idOf(res)));
}

export async function updateStatus(req: Request, res: Response) {
  const data = await appointments.updateStatus(currentUser(req), idOf(res), input<UpdateStatusBody>(res, "body"));
  ok(res, "Appointment updated", data);
}

export async function cancel(req: Request, res: Response) {
  const { reason } = input<{ reason?: string }>(res, "body");
  ok(res, "Appointment cancelled", await appointments.cancelAppointment(currentUser(req), idOf(res), reason));
}

export async function reschedule(req: Request, res: Response) {
  const data = await appointments.rescheduleAppointment(currentUser(req), idOf(res), input<RescheduleBody>(res, "body"));
  ok(res, "Appointment rescheduled", data);
}

export async function writePrescription(req: Request, res: Response) {
  const data = await prescriptions.upsertPrescription(currentUser(req), apptIdOf(res), input<PrescriptionBody>(res, "body"));
  ok(res, "Prescription saved", data);
}

export async function getPrescription(req: Request, res: Response) {
  ok(res, "Prescription fetched", await prescriptions.getPrescriptionForAppointment(currentUser(req), apptIdOf(res)));
}

export async function review(req: Request, res: Response) {
  created(res, "Review submitted", await reviews.createReview(currentUser(req), apptIdOf(res), input<ReviewBody>(res, "body")));
}
