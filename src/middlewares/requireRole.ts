import type { NextFunction, Request, Response } from "express";
import type { Role } from "../types/auth";
import { AppError } from "../utils/AppError";

// Coarse role gate. Place after `authenticate`. Record-level access (ownership,
// receptionist assignments) is checked in services/policies.
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}
