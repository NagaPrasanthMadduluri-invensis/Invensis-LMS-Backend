import { eq, lt } from "drizzle-orm";
import { db } from "../config/db.js";
import { revokedRefreshTokens } from "../db/schema.js";

/**
 * Refresh-token denylist abstraction.
 *
 * Postgres-backed implementation for now. To move to Redis later, implement the
 * same { isRevoked, revoke, purgeExpired } interface against ioredis (using the
 * token's remaining TTL as the key expiry) and swap this export.
 */
export const tokenStore = {
  async isRevoked(jti) {
    const rows = await db
      .select({ jti: revokedRefreshTokens.jti })
      .from(revokedRefreshTokens)
      .where(eq(revokedRefreshTokens.jti, jti))
      .limit(1);
    return rows.length > 0;
  },

  async revoke(jti, userId, expiresAt) {
    await db
      .insert(revokedRefreshTokens)
      .values({ jti, userId, expiresAt })
      .onConflictDoNothing();
  },

  // Housekeeping — drop entries that are already past their own expiry.
  async purgeExpired(now = new Date()) {
    await db
      .delete(revokedRefreshTokens)
      .where(lt(revokedRefreshTokens.expiresAt, now));
  },
};
