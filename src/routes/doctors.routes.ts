import { Router } from "express";
import { z } from "zod";
import * as c from "../controllers/doctors.controller";
import { authenticate, optionalAuthenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import { paginationSchema } from "../utils/pagination";
import { id } from "../validators/common";
import {
  availabilityBody,
  availabilityItemParams,
  doctorClinicParams,
  doctorIdParam,
  searchDoctorsQuery,
  slotsQuery,
  timeOffBody,
  timeOffQuery,
  updateDoctorProfileBody,
} from "../validators/doctors";

const router = Router();
const publicDoctorParam = z.object({ doctorId: id });
const STAFF = requireRole("DOCTOR", "RECEPTIONIST", "ADMIN");

// ---- own profile: must come before /:doctorId
router.get("/me/profile", authenticate, requireRole("DOCTOR"), c.getMyProfile);
router.put("/me/profile", authenticate, requireRole("DOCTOR"), validate({ body: updateDoctorProfileBody }), c.updateMyProfile);

// ---- public discovery (a token is optional; patients get their saved location as the default)
router.get("/", optionalAuthenticate, validate({ query: searchDoctorsQuery }), c.search);
router.get("/:doctorId", optionalAuthenticate, validate({ params: publicDoctorParam }), c.details);
router.get("/:doctorId/slots", optionalAuthenticate, validate({ params: publicDoctorParam, query: slotsQuery }), c.slots);
router.get("/:doctorId/reviews", validate({ params: publicDoctorParam, query: paginationSchema }), c.listReviews);

// ---- schedule management (doctor: own via "me" or their id; receptionist: assigned doctors; admin: any)
router.get("/:doctorId/clinics", authenticate, STAFF, validate({ params: doctorIdParam }), c.listClinics);
router.put("/:doctorId/clinics/:clinicId", authenticate, STAFF, validate({ params: doctorClinicParams }), c.linkClinic);
router.delete("/:doctorId/clinics/:clinicId", authenticate, STAFF, validate({ params: doctorClinicParams }), c.unlinkClinic);

router.get("/:doctorId/availability", authenticate, STAFF, validate({ params: doctorIdParam }), c.listAvailability);
router.post(
  "/:doctorId/availability",
  authenticate,
  STAFF,
  validate({ params: doctorIdParam, body: availabilityBody }),
  c.createAvailability,
);
router.put(
  "/:doctorId/availability/:id",
  authenticate,
  STAFF,
  validate({ params: availabilityItemParams, body: availabilityBody }),
  c.updateAvailability,
);
router.delete(
  "/:doctorId/availability/:id",
  authenticate,
  STAFF,
  validate({ params: availabilityItemParams }),
  c.deleteAvailability,
);

router.get("/:doctorId/time-off", authenticate, STAFF, validate({ params: doctorIdParam, query: timeOffQuery }), c.listTimeOff);
router.post("/:doctorId/time-off", authenticate, STAFF, validate({ params: doctorIdParam, body: timeOffBody }), c.createTimeOff);
router.delete(
  "/:doctorId/time-off/:id",
  authenticate,
  STAFF,
  validate({ params: availabilityItemParams }),
  c.deleteTimeOff,
);

export default router;
