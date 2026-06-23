import { verifyAccessToken } from "../lib/jwt.js";
import { AppError } from "../lib/errors.js";

// Parses + verifies the access token, attaching { user_id, role, email } to req.user.
export function verifyToken(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new AppError("Authentication required", 401));
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(new AppError("Invalid or expired token", 401));
  }
}
