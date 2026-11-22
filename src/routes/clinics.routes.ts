import { Router } from "express";
import * as c from "../controllers/clinics.controller";
import { authenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import { clinicBody, searchClinicsQuery, updateClinicBody } from "../validators/clinics";
import { idParam } from "../validators/common";

const router = Router();

router.get("/", validate({ query: searchClinicsQuery }), c.search);
router.get("/:id", validate({ params: idParam }), c.get);
router.post("/", authenticate, requireRole("DOCTOR", "ADMIN"), validate({ body: clinicBody }), c.create);
router.patch("/:id", authenticate, requireRole("DOCTOR", "ADMIN"), validate({ params: idParam, body: updateClinicBody }), c.update);
router.delete("/:id", authenticate, requireRole("ADMIN"), validate({ params: idParam }), c.remove);

export default router;
