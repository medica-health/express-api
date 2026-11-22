import { z } from "zod";

// Validated application config. Import `env` instead of reading process.env directly.
// `dotenv/config` is loaded first in server.ts, so process.env is populated by the time this runs.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // JWT issued by spring-api (HS256, shared secret)
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("cdac-auth"),
  JWT_AUDIENCE: z.string().default("cdac-api"),

  // Email via Resend. Leave RESEND_API_KEY empty to only log emails (dev/tests).
  // MAIL_FROM must use a domain verified in Resend; onboarding@resend.dev only delivers to
  // the Resend account owner's address (useful for a first test).
  RESEND_API_KEY: z.string().optional().default(""),
  MAIL_FROM: z.string().default("MediCare <onboarding@resend.dev>"),
  MAIL_REPLY_TO: z.string().optional().default(""),
  APP_BASE_URL: z.string().default("http://localhost:3000"),

  // Redis (optional): slot holds, free-slot cache, rate limiting. Empty = those features are off.
  REDIS_URL: z.string().optional().default(""),
  // How long a patient can hold a slot while confirming the booking.
  SLOT_HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  // Free-slot cache lifetime. Writes invalidate it immediately; the TTL is a safety net.
  SLOT_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Background jobs (reminder emails). Disable in tests or extra replicas if desired.
  JOBS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
