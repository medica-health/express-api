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

  // Email (optional: if SMTP_HOST is empty, emails are logged instead of sent)
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  MAIL_FROM: z.string().default("MediCare <no-reply@cdac.local>"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),

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
