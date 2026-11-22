import "dotenv/config"; // must be first: loads .env before config modules read process.env
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { connectMongo, disconnectMongo, mongoStatus } from "./config/mongo";
import { connectPostgres, disconnectPostgres, postgresStatus } from "./config/postgres";

const app = express();

app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGINS || "http://localhost:3000").split(",") }));
app.use(express.json());
app.use(morgan("dev"));

const PORT = process.env.PORT || 5000;
const ENV = process.env.NODE_ENV || "development";

app.get("/api/health", async (_req, res) => {
  const [postgres, mongodb] = await Promise.all([postgresStatus(), mongoStatus()]);
  res.status(200).json({
    success: true,
    message: "API is running successfully",
    data: {
      environment: ENV,
      databases: { postgres, mongodb },
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.status(200).json({
    message: "Running",
  });
});

async function start() {
  await Promise.all([connectMongo(), connectPostgres()]);

  const server = app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await Promise.allSettled([disconnectMongo(), disconnectPostgres()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
