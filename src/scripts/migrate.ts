import "dotenv/config"; // must be first
import { pool } from "../config/postgres";
import { runMigrations } from "../db/migrate";

// `bun run migrate`: apply pending app-schema migrations and exit.
try {
  await runMigrations();
  console.log("Migrations up to date");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
