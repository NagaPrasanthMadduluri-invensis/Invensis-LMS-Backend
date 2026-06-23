import { AppError } from "../lib/errors.js";

// Role guard — use after verifyToken, e.g. requireRole("admin")
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError("Insufficient permissions", 403));
    }
    next();
  };
