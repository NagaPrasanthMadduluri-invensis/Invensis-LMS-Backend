/**
 * Account-setup / password-reset token lifecycle.
 *
 * A user auto-provisioned by the system (CRM order, admin add) has no password.
 * We email them a single-use token; they exchange it for a password via
 * POST /api/auth/set-password. The same machinery backs forgot-password.
 *
 * Only the SHA-256 hash of a token is stored; the raw value lives only in the
 * emailed link.
 */
import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { passwordSetupTokens } from "../db/schema.js";
import { sendAccountSetupEmail, sendPasswordResetEmail } from "./mailer.js";

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

function buildLink(raw, purpose) {
  const path = purpose === "reset" ? "/reset-password" : "/set-password";
  return `${env.FRONTEND_URL}${path}?token=${raw}`;
}

/**
 * Create a fresh token for a user, superseding any prior unused token of the
 * same purpose. `runner` is a db or tx handle. Returns the raw token.
 */
export async function createSetupToken(runner, userId, purpose) {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.SETUP_TOKEN_TTL_HOURS * 3600 * 1000);

  // Invalidate earlier unused tokens of this purpose (one live link at a time).
  await runner
    .update(passwordSetupTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordSetupTokens.userId, userId),
        eq(passwordSetupTokens.purpose, purpose),
        isNull(passwordSetupTokens.usedAt)
      )
    );

  await runner.insert(passwordSetupTokens).values({
    userId,
    tokenHash: hashToken(raw),
    purpose,
    expiresAt,
  });

  return { raw, expiresAt };
}

/**
 * Issue a token and email the link. Never throws — a mail failure must not roll
 * back an already-committed account creation; it's logged for follow-up.
 * `user` = { id, name, email }.
 */
export async function provisionAccountSetup(user, purpose = "setup") {
  try {
    const { raw } = await createSetupToken(db, user.id, purpose);
    const link = buildLink(raw, purpose);
    if (purpose === "reset") await sendPasswordResetEmail(user, link);
    else await sendAccountSetupEmail(user, link);
  } catch (err) {
    console.error(
      `[account-setup] failed to provision ${purpose} for ${user.email}: ${err.message}`
    );
  }
}

/** Look up a valid (unused, unexpired) token by its raw value. */
export async function findValidToken(runner, raw) {
  const [row] = await runner
    .select()
    .from(passwordSetupTokens)
    .where(eq(passwordSetupTokens.tokenHash, hashToken(raw)))
    .limit(1);
  if (!row || row.usedAt || row.expiresAt <= new Date()) return null;
  return row;
}

/**
 * Atomically claim a token (mark used only if still unused). Returns true if
 * this call won the claim — guards against a token being consumed twice.
 */
export async function claimToken(runner, id) {
  const claimed = await runner
    .update(passwordSetupTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordSetupTokens.id, id), isNull(passwordSetupTokens.usedAt)))
    .returning({ id: passwordSetupTokens.id });
  return claimed.length > 0;
}
