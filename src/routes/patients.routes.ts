import { Router } from "express";
import * as c from "../controllers/patients.controller";
import { authenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import { paginationSchema } from "../utils/pagination";
import { patientIdParam, patientLookupQuery, updatePatientProfileBody } from "../validators/clinical";
import { idParam } from "../validators/common";

const router = Router();
router.use(authenticate);

router.get("/me/profile", requireRole("PATIENT"), c.getMyProfile);
router.put("/me/profile", requireRole("PATIENT"), validate({ body: updatePatientProfileBody }), c.updateMyProfile);

// Front desk: find an existing patient account by email to book for them.
router.get("/lookup", requireRole("RECEPTIONIST", "ADMIN"), validate({ query: patientLookupQuery }), c.lookup);
// Doctors: patients they've seen. Receptionists: patients of their assigned doctors.
router.get("/", requireRole("DOCTOR", "RECEPTIONIST"), c.myPatients);

// Clinical data: the patient, or a doctor who has treated them.
router.get("/:patientId/summary", requireRole("PATIENT", "DOCTOR"), validate({ params: patientIdParam }), c.summary);
router.get(
  "/:patientId/prescriptions",
  requireRole("PATIENT", "DOCTOR"),
  validate({ params: patientIdParam, query: paginationSchema }),
  c.prescriptionsOf,
);

export const prescriptionsRouter = Router();
prescriptionsRouter.get("/:id", authenticate, requireRole("PATIENT", "DOCTOR"), validate({ params: idParam }), c.getPrescription);

export default router;
