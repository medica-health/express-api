import type { NextFunction, Request, Response } from "express";
import { errors as joseErrors, jwtVerify } from "jose";
import { env } from "../config/env";
import { ROLES, type AuthUser, type Role } from "../types/auth";
import { AppError } from "../utils/AppError";

const secret = new TextEncoder().encode(env.JWT_SECRET);

// Verifies an HS256 access token issued by spring-api and returns the caller.
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const role = payload.role as Role;
    if (!payload.sub || typeof payload.email !== "string" || !ROLES.includes(role)) {
      throw AppError.unauthorized("Invalid token claims");
    }
    return {
      id: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : payload.email,
      role,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw AppError.unauthorized("Token expired");
    throw AppError.unauthorized("Invalid token");
  }
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

// Requires a valid access token; sets req.user.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next(AppError.unauthorized());
  try {
    req.user = await verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

// Sets req.user when a valid token is present, but lets anonymous requests through.
// An invalid token is still rejected so clients notice they need to refresh.
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next();
  try {
    req.user = await verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

// Returns req.user, or throws 401. Use in controllers behind `authenticate`.
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
