import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

// Parses req.body / req.query / req.params with zod. Parsed (coerced, defaulted) values
// are stored on res.locals.{body,query,params}, because Express 5 makes req.query read-only.
// Read them in controllers with the `input()` helper below.
export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.params) res.locals.params = schemas.params.parse(req.params);
      if (schemas.query) res.locals.query = schemas.query.parse(req.query);
      if (schemas.body) res.locals.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function input<T>(res: Response, part: "body" | "query" | "params"): T {
  return res.locals[part] as T;
}
