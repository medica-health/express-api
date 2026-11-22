import "dotenv/config"; // must be first
import { SignJWT } from "jose";
import { parseArgs } from "node:util";

// DEV ONLY: mints an access token the way spring-api will, so the API can be exercised
// before the Spring auth endpoints exist.
//
//   bun run token -- --email doctor1@demo.local        (looks the user up in auth.users)
//   bun run token -- --sub <uuid> --role ADMIN --email a@b.c --name "Admin"
if (process.env.NODE_ENV === "production") {
  console.error("dev-token is disabled when NODE_ENV=production");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    sub: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    ttl: { type: "string", default: "8h" },
  },
});

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error("JWT_SECRET (>= 32 chars) must be set in .env");
  process.exit(1);
}

let { sub, role, name } = values;
const { email } = values;

if (!sub && email) {
  const { findUserByEmail } = await import("../services/users.service");
  const { pool } = await import("../config/postgres");
  const user = await findUserByEmail(email);
  await pool.end();
  if (!user) {
    console.error(`No user with email ${email} in auth.users (run \`bun run seed\` first)`);
    process.exit(1);
  }
  ({ id: sub, role, full_name: name } = user);
}

if (!sub || !role || !email) {
  console.error("Provide --email (lookup) or --sub, --role and --email");
  process.exit(1);
}

const token = await new SignJWT({ email, name: name ?? email, role })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject(sub)
  .setIssuer(process.env.JWT_ISSUER || "cdac-auth")
  .setAudience(process.env.JWT_AUDIENCE || "cdac-api")
  .setIssuedAt()
  .setExpirationTime(values.ttl!)
  .sign(new TextEncoder().encode(secret));

console.log(token);
