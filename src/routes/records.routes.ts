import { Router } from "express";
import multer from "multer";
import * as c from "../controllers/records.controller";
import { authenticate } from "../middlewares/authenticate";
import { requireRole } from "../middlewares/requireRole";
import { validate } from "../middlewares/validate";
import { MAX_RECORD_BYTES } from "../services/records.service";
import { listRecordsQuery, uploadRecordBody } from "../validators/clinical";
import { idParam } from "../validators/common";

// Files are buffered in memory (max 10 MB), content-sniffed, then streamed to GridFS.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RECORD_BYTES, files: 1 } });

const router = Router();
router.use(authenticate, requireRole("PATIENT", "DOCTOR"));

router.post("/", upload.single("file"), validate({ body: uploadRecordBody }), c.upload);
router.get("/", validate({ query: listRecordsQuery }), c.list);
router.get("/:id/download", validate({ params: idParam }), c.download);
router.delete("/:id", validate({ params: idParam }), c.remove);

export default router;
