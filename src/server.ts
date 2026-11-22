import "dotenv/config"; // must be first: loads .env before config modules read process.env
import { createApp } from "./app";
import { env } from "./config/env";
import { connectMongo, disconnectMongo } from "./config/mongo";
import { connectPostgres, disconnectPostgres } from "./config/postgres";
import { runMigrations } from "./db/migrate";
import { startJobs, stopJobs } from "./jobs/reminders";

async function start() {
  await Promise.all([connectMongo(), connectPostgres()]);

  // Migrations need Postgres and spring-api's auth schema. A failure is logged rather than
  // fatal, matching the existing "DB down is not fatal" behaviour; /api/health shows DB state.
  try {
    await runMigrations();
  } catch (err) {
    console.error("Database migrations failed:", (err as Error).message);
  }

  if (env.JOBS_ENABLED) startJobs();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`API running on http://localhost:${env.PORT}`);
  });

  const shutdown = async () => {
    stopJobs();
    server.close();
    await Promise.allSettled([disconnectMongo(), disconnectPostgres()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
