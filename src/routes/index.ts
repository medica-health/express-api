import { Router } from "express";
import { listSpecializations, dashboard } from "../controllers/admin.controller";
import { authenticate } from "../middlewares/authenticate";
import adminRoutes from "./admin.routes";
import appointmentRoutes from "./appointments.routes";
import clinicRoutes from "./clinics.routes";
import doctorRoutes from "./doctors.routes";
import patientRoutes, { prescriptionsRouter } from "./patients.routes";
import recordRoutes from "./records.routes";

// Mounted at /api. Authentication tokens are issued by spring-api (/api/auth/*).
const api = Router();

api.get("/specializations", listSpecializations);
api.get("/dashboard/me", authenticate, dashboard);

api.use("/doctors", doctorRoutes);
api.use("/clinics", clinicRoutes);
api.use("/patients", patientRoutes);
api.use("/appointments", appointmentRoutes);
api.use("/prescriptions", prescriptionsRouter);
api.use("/medical-records", recordRoutes);
api.use("/admin", adminRoutes);

export default api;
