import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";

// Access token — short-lived, carried in memory by the client (§9.1)
export function signAccessToken(user) {
  return jwt.sign(
    { user_id: user.id, role: user.role, email: user.email },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL }
  );
}

// Refresh token — long-lived, stored in an httpOnly cookie. Carries a jti
// (for the denylist) and token_version (for bulk invalidation).
export function signRefreshToken(user, jti = randomUUID()) {
  const token = jwt.sign(
    { user_id: user.id, token_version: user.tokenVersion, jti },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.REFRESH_TOKEN_TTL }
  );
  const { exp } = jwt.decode(token);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}
