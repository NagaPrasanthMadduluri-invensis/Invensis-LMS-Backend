import { loginSchema } from "./auth.schema.js";
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
  const { user, accessToken, refresh, capabilities } = await authService.login(data);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
  res.json({ user, accessToken, capabilities });
}

export async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  const { user, accessToken, refresh, capabilities } = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
  res.json({ user, accessToken, capabilities });
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
