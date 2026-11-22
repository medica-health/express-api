import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cdac_db";

// Shared connection pool - import `pool` wherever you need to run SQL:
//   const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

export async function connectPostgres(): Promise<void> {
  try {
    await pool.query("SELECT 1");
    console.log("PostgreSQL connected");
  } catch (err) {
    const e = err as Error & { code?: string };
    console.error("PostgreSQL connection failed:", e.message || e.code || String(err));
  }
}

export async function postgresStatus(): Promise<"up" | "down"> {
  try {
    await pool.query("SELECT 1");
    return "up";
  } catch {
    return "down";
  }
}

export async function disconnectPostgres(): Promise<void> {
  await pool.end();
}
