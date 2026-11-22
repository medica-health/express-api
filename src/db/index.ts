import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../config/postgres";

// Anything that can run a query: the shared pool or a transaction client.
export type Queryable = Pick<PoolClient, "query">;

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const { rows } = await db.query<T>(sql, params);
  return rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | undefined> {
  const rows = await query<T>(sql, params, db);
  return rows[0];
}

// Runs `fn` inside BEGIN/COMMIT, rolling back on any error.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
