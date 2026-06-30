import { eq } from "drizzle-orm";
import { db } from "../../config/db.js";
import { users } from "../../db/schema.js";
import { verifyPassword } from "../../lib/password.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt.js";
import { tokenStore } from "../../lib/token-store.js";
import { AppError } from "../../lib/errors.js";
import { resolveCapabilities, resolveSponsor } from "../../lib/capabilities.js";

async function findByEmail(email) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user ?? null;
}

async function findById(id) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

// Shape returned to the client — never leaks password_hash / token_version.
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive };
}

// Capabilities + (for learners) who sponsored them. Returned by login/refresh/me.
async function accessContext(user) {
  const capabilities = await resolveCapabilities(user);
  const sponsor = capabilities.learner ? await resolveSponsor(user.id) : null;
  return { capabilities, sponsor };
}

export async function login({ email, password }) {
  const user = await findByEmail(email);
  if (!user || !user.passwordHash) {
    throw new AppError("Invalid email or password", 401);
  }
  if (!user.isActive) {
    throw new AppError("Account is inactive", 403);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new AppError("Invalid email or password", 401);
  }
  return {
    user: publicUser(user),
    accessToken: signAccessToken(user),
    refresh: signRefreshToken(user),
    ...(await accessContext(user)),
  };
}

export async function refresh(refreshToken) {
  if (!refreshToken) throw new AppError("Refresh token missing", 401);

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError("Invalid or expired refresh token", 401);
  }

  if (await tokenStore.isRevoked(payload.jti)) {
    throw new AppError("Refresh token has been revoked", 401);
  }

  const user = await findById(payload.user_id);
  if (!user || !user.isActive) {
    throw new AppError("Account not found or inactive", 401);
  }
  if (user.tokenVersion !== payload.token_version) {
    throw new AppError("Refresh token no longer valid", 401);
  }

  // Rotate: revoke the presented token, then mint a fresh pair.
  await tokenStore.revoke(payload.jti, user.id, new Date(payload.exp * 1000));

  return {
    user: publicUser(user),
    accessToken: signAccessToken(user),
    refresh: signRefreshToken(user),
    ...(await accessContext(user)),
  };
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    await tokenStore.revoke(
      payload.jti,
      payload.user_id,
      new Date(payload.exp * 1000)
    );
  } catch {
    // Token already invalid/expired — nothing to revoke.
  }
}

export async function me(userId) {
  const user = await findById(userId);
  if (!user) throw new AppError("User not found", 404);
  return {
    user: publicUser(user),
    ...(await accessContext(user)),
  };
}
