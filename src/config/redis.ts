import { Redis } from "ioredis";
import { env } from "./env";

// Optional Redis. It powers slot holds, the free-slot cache and rate limiting. None of those
// are needed for correctness (Postgres exclusion constraints prevent double booking), so the
// app runs without Redis: leave REDIS_URL empty, or if Redis goes down, every Redis feature
// fails open (holds return 503, cache and rate limits are skipped).

let client: Redis | null = null;
let warned = false;

if (env.REDIS_URL) {
  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    // Fail fast instead of queueing commands while disconnected, so requests never hang on Redis.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  client.on("error", (err) => {
    // ioredis emits an error on every reconnect attempt; log once until it reconnects.
    if (!warned) console.error("Redis error:", err.message || (err as { code?: string }).code || "connection lost");
    warned = true;
  });
  client.on("ready", () => {
    warned = false;
  });
}

/** The Redis client when configured and connected, otherwise null (callers fail open). */
export function redis(): Redis | null {
  return client && client.status === "ready" ? client : null;
}

export function redisConfigured(): boolean {
  return client !== null;
}

export async function connectRedis(): Promise<void> {
  if (!client) {
    console.log("Redis not configured (REDIS_URL empty): slot holds, slot cache and rate limits are off");
    return;
  }
  try {
    await client.connect();
    console.log("Redis connected");
  } catch (err) {
    console.error("Redis connection failed:", (err as Error).message);
  }
}

export async function redisStatus(): Promise<"up" | "down" | "disabled"> {
  if (!client) return "disabled";
  try {
    await client.ping();
    return "up";
  } catch {
    return "down";
  }
}

export async function disconnectRedis(): Promise<void> {
  if (client) await client.quit().catch(() => client?.disconnect());
}

/** Runs a Redis operation, returning `fallback` when Redis is unavailable or the call fails. */
export async function withRedis<T>(fallback: T, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = redis();
  if (!r) return fallback;
  try {
    return await fn(r);
  } catch (err) {
    console.error("Redis command failed:", (err as Error).message);
    return fallback;
  }
}
