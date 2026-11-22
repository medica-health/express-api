import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 5 already forwards rejected promises to the error handler, but this wrapper
// keeps controller signatures explicit and typed.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
