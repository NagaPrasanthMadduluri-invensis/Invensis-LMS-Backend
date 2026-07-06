import { loginSchema, forgotPasswordSchema, setPasswordSchema } from "./auth.schema.js";
import * as authService from "./auth.service.js";
import { env } from "../../config/env.js";

const REFRESH_COOKIE = "refresh_token";

// Cookie is scoped to /api/auth so it is only sent to refresh/logout.
function refreshCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: "/api/auth",
    expires: expiresAt,
  };
}

export async function login(req, res) {
  const data = loginSchema.parse(req.body);
  const { user, accessToken, refresh, capabilities, sponsor } = await authService.login(data);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
  res.json({ user, accessToken, capabilities, sponsor });
}

export async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  const { user, accessToken, refresh, capabilities, sponsor } = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
  res.json({ user, accessToken, capabilities, sponsor });
}

export async function logout(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  await authService.logout(token);
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.status(204).end();
}

export async function me(req, res) {
  const result = await authService.me(req.user.user_id);
  res.json(result); // { user, capabilities }
}

export async function forgotPassword(req, res) {
  const { email } = forgotPasswordSchema.parse(req.body);
  await authService.forgotPassword(email);
  // Same response whether or not the account exists (no enumeration).
  res.json({ message: "If an account exists for that email, a reset link has been sent." });
}

export async function setPassword(req, res) {
  const { token, password } = setPasswordSchema.parse(req.body);
  await authService.setPassword(token, password);
  res.json({ message: "Password set. You can now log in." });
}
