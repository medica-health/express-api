import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/postgres";

const MIGRATIONS_DIR = path.join(import.meta.dir, "migrations");
// Arbitrary constant so concurrent pods don't run migrations at the same time.
const LOCK_KEY = 72_410_001;

// Applies src/db/migrations/*.sql in filename order, once each, tracked in
// app.schema_migrations. Each file runs in its own transaction.
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    const { rows: authCheck } = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('auth.users') IS NOT NULL AS exists",
    );
    if (!authCheck[0]?.exists) {
      throw new Error(
        "Table auth.users does not exist. It is created by spring-api's Flyway migrations: " +
          "start spring-api first (docker compose does this via depends_on).",
      );
    }

    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM app.schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO app.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Migration applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
