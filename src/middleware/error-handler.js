import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";

export function notFound(_req, res) {
  res.status(404).json({ message: "Route not found" });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const errors = err.flatten().fieldErrors;
    // Log field names + messages (never the payload values) so 422s are diagnosable.
    req.log?.warn({ url: req.originalUrl, validation: errors }, "validation failed");
    return res.status(422).json({ message: "Validation failed", errors });
  }
  if (err instanceof AppError) {
    if (err.status === 422) {
      req.log?.warn({ url: req.originalUrl }, err.message);
    }
    return res.status(err.status).json({ message: err.message });
  }
  req.log?.error(err);
  res.status(500).json({ message: "Internal server error" });
}
