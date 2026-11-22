export const ROLES = ["PATIENT", "DOCTOR", "RECEPTIONIST", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

// The authenticated caller, decoded from the spring-api access token.
export interface AuthUser {
  id: string; // JWT `sub` (auth.users.id)
  email: string;
  name: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}
