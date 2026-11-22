import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { AppError } from "../utils/AppError";

interface RateLimitOptions {
  /** Bucket name, e.g. "book". Each name is counted separately. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window rate limit shared by all replicas through Redis. Counts per user when
 * authenticated (place after `authenticate`), otherwise per client IP. Fails open: without
 * Redis, or if Redis errors, requests are not limited.
 */
export function rateLimit({ name, limit, windowSeconds }: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const r = env.RATE_LIMIT_ENABLED ? redis() : null;
    if (!r) return next();

    const who = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const windowMs = windowSeconds * 1000;
    const window = Math.floor(Date.now() / windowMs);
    const key = `rl:${name}:${who}:${window}`;

    let count: number;
    try {
      const results = await r.multi().incr(key).expire(key, windowSeconds + 1).exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch (err) {
      console.error("Rate limit check failed:", (err as Error).message);
      return next();
    }

    const resetSeconds = Math.ceil(((window + 1) * windowMs - Date.now()) / 1000);
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - count)));
    res.setHeader("RateLimit-Reset", String(resetSeconds));
    if (count > limit) {
      res.setHeader("Retry-After", String(resetSeconds));
      return next(new AppError(429, `Too many requests. Try again in ${resetSeconds} seconds.`));
    }
    next();
  };
}
