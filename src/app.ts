import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { mongoStatus } from "./config/mongo";
import { postgresStatus } from "./config/postgres";
import { redisStatus } from "./config/redis";
import { errorHandler, notFound } from "./middlewares/errorHandler";
import api from "./routes";

// Builds the Express app without listening, so tests can import it.
export function createApp() {
  const app = express();

  app.set("trust proxy", 1); // behind the ALB / ingress
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  if (env.NODE_ENV !== "test") app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/", (_req, res) => {
    res.status(200).json({ message: "Running" });
  });

  app.get("/api/health", async (_req, res) => {
    const [postgres, mongodb, redis] = await Promise.all([postgresStatus(), mongoStatus(), redisStatus()]);
    res.status(200).json({
      success: true,
      message: "API is running successfully",
      data: { environment: env.NODE_ENV, databases: { postgres, mongodb, redis } },
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
