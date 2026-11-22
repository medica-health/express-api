import { Router } from "express";
import * as c from "../controllers/appointments.controller";
import { authenticate } from "../middlewares/authenticate";
import { rateLimit } from "../middlewares/rateLimit";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import {
  bookAppointmentBody,
  cancelBody,
  holdIdParam,
  holdSlotBody,
  listAppointmentsQuery,
  rescheduleBody,
  updateStatusBody,
} from "../validators/appointments";
import { appointmentIdParam, prescriptionBody, reviewBody } from "../validators/clinical";
import { idParam } from "../validators/common";

const router = Router();
router.use(authenticate);

const BOOKERS = requireRole("PATIENT", "RECEPTIONIST", "ADMIN");
// Per-user limits (Redis; skipped when Redis is unavailable). Front-desk staff book all day,
// so the limits are generous; they stop scripts hammering the slot inventory.
const bookingLimit = rateLimit({ name: "book", limit: 20, windowSeconds: 60 });
const holdLimit = rateLimit({ name: "hold", limit: 30, windowSeconds: 60 });
const resendLimit = rateLimit({ name: "resend", limit: 3, windowSeconds: 3600 });
const changeLimit = rateLimit({ name: "change", limit: 20, windowSeconds: 60 });

// Slot holds: reserve a slot for a few minutes while confirming. Must come before /:id.
router.post("/holds", BOOKERS, holdLimit, validate({ body: holdSlotBody }), c.hold);
router.get("/holds/me", BOOKERS, c.myHold);
router.delete("/holds/:holdId", BOOKERS, validate({ params: holdIdParam }), c.releaseHold);

// Doctors don't book: patients book for themselves, front desk/admin book on their behalf.
router.post("/", BOOKERS, bookingLimit, validate({ body: bookAppointmentBody }), c.book);
// Every role may list/view; results are scoped to the caller in the service.
router.get("/", validate({ query: listAppointmentsQuery }), c.list);
router.get("/:id", validate({ params: idParam }), c.get);

router.patch(
  "/:id/status",
  requireRole("DOCTOR", "RECEPTIONIST", "ADMIN"),
  validate({ params: idParam, body: updateStatusBody }),
  c.updateStatus,
);
router.post("/:id/cancel", changeLimit, validate({ params: idParam, body: cancelBody }), c.cancel);
router.post(
  "/:id/reschedule",
  requireRole("PATIENT", "RECEPTIONIST", "ADMIN", "DOCTOR"),
  changeLimit,
  validate({ params: idParam, body: rescheduleBody }),
  c.reschedule,
);
router.post(
  "/:id/resend-confirmation",
  BOOKERS,
  resendLimit,
  validate({ params: idParam }),
  c.resendConfirmation,
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
