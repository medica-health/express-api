import { Router } from "express";
import * as c from "../controllers/admin.controller";
import { authenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import {
  adminDoctorsQuery,
  assignmentBody,
  assignmentsQuery,
  auditQuery,
  specializationBody,
  specializationIdParam,
  verificationBody,
} from "../validators/admin";
import { idParam } from "../validators/common";

const router = Router();
router.use(authenticate, requireRole("ADMIN"));

router.get("/stats", c.stats);
router.get("/audit-logs", validate({ query: auditQuery }), c.auditLogs);

router.get("/doctors", validate({ query: adminDoctorsQuery }), c.listDoctors);
router.patch("/doctors/:id/verification", validate({ params: idParam, body: verificationBody }), c.verifyDoctor);

router.post("/specializations", validate({ body: specializationBody }), c.createSpecialization);
router.put("/specializations/:id", validate({ params: specializationIdParam, body: specializationBody }), c.updateSpecialization);
router.delete("/specializations/:id", validate({ params: specializationIdParam }), c.deleteSpecialization);

router.get("/assignments", validate({ query: assignmentsQuery }), c.listAssignments);
router.post("/assignments", validate({ body: assignmentBody }), c.createAssignment);
router.delete("/assignments", validate({ body: assignmentBody }), c.deleteAssignment);

router.delete("/reviews/:id", validate({ params: idParam }), c.removeReview);

export default router;
