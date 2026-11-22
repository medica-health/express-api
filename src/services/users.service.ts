import { queryOne, type Queryable } from "../db";
import type { Role } from "../types/auth";
import { AppError } from "../utils/AppError";

// Read-only access to auth.users (owned by spring-api).
export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: Role;
  enabled: boolean;
}

const COLUMNS = "id, email::text AS email, full_name, phone, role, enabled";

export async function findUserById(id: string, db?: Queryable): Promise<UserRow | undefined> {
  return queryOne<UserRow>(`SELECT ${COLUMNS} FROM auth.users WHERE id = $1`, [id], db);
}

export async function findUserByEmail(email: string, db?: Queryable): Promise<UserRow | undefined> {
  return queryOne<UserRow>(`SELECT ${COLUMNS} FROM auth.users WHERE email = $1`, [email], db);
}

/** Loads an enabled user with the given role, or throws 404. */
export async function requireUserWithRole(id: string, role: Role, db?: Queryable): Promise<UserRow> {
  const user = await findUserById(id, db);
  if (!user || !user.enabled || user.role !== role) {
    throw AppError.notFound(`${role.charAt(0)}${role.slice(1).toLowerCase()} not found`);
  }
  return user;
}
