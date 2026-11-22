// Operational error carrying an HTTP status. Thrown from services/middlewares and
// turned into the standard response envelope by middlewares/errorHandler.ts.
export class AppError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }

  static badRequest(message = "Bad request", details?: unknown) {
    return new AppError(400, message, details);
  }
  static unauthorized(message = "Authentication required") {
    return new AppError(401, message);
  }
  static forbidden(message = "You do not have permission to perform this action") {
    return new AppError(403, message);
  }
  static notFound(message = "Resource not found") {
    return new AppError(404, message);
  }
  static conflict(message = "Conflict", details?: unknown) {
    return new AppError(409, message, details);
  }
}
