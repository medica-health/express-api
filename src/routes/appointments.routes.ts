import { Router } from "express";
import * as c from "../controllers/appointments.controller";
import { authenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import {
  bookAppointmentBody,
  cancelBody,
  listAppointmentsQuery,
  rescheduleBody,
  updateStatusBody,
} from "../validators/appointments";
import { appointmentIdParam, prescriptionBody, reviewBody } from "../validators/clinical";
import { idParam } from "../validators/common";

const router = Router();
router.use(authenticate);

// Doctors don't book: patients book for themselves, front desk/admin book on their behalf.
router.post("/", requireRole("PATIENT", "RECEPTIONIST", "ADMIN"), validate({ body: bookAppointmentBody }), c.book);
// Every role may list/view; results are scoped to the caller in the service.
router.get("/", validate({ query: listAppointmentsQuery }), c.list);
router.get("/:id", validate({ params: idParam }), c.get);

router.patch(
  "/:id/status",
  requireRole("DOCTOR", "RECEPTIONIST", "ADMIN"),
  validate({ params: idParam, body: updateStatusBody }),
  c.updateStatus,
);
router.post("/:id/cancel", validate({ params: idParam, body: cancelBody }), c.cancel);
router.post(
  "/:id/reschedule",
  requireRole("PATIENT", "RECEPTIONIST", "ADMIN", "DOCTOR"),
  validate({ params: idParam, body: rescheduleBody }),
  c.reschedule,
);

// Prescription for an appointment: written by its doctor, readable by the patient and treating doctors.
router.put(
  "/:appointmentId/prescription",
  requireRole("DOCTOR"),
  validate({ params: appointmentIdParam, body: prescriptionBody }),
  c.writePrescription,
);
router.get(
  "/:appointmentId/prescription",
  requireRole("PATIENT", "DOCTOR"),
  validate({ params: appointmentIdParam }),
  c.getPrescription,
);

router.post(
  "/:appointmentId/review",
  requireRole("PATIENT"),
  validate({ params: appointmentIdParam, body: reviewBody }),
  c.review,
);

export default router;
