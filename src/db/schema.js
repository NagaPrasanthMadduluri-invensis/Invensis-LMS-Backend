import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

// User roles per the architecture doc (§3.1)
export const roleEnum = pgEnum("role", [
  "admin",
  "trainer",
  "sponsor",
  "learner",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`), // PG 18 native, time-ordered
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  passwordHash: text("password_hash"), // null for OAuth users
  isActive: boolean("is_active").notNull().default(true),
  // Bump to invalidate every existing refresh token for this user at once
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Refresh-token denylist (logout + rotation). Backed by Postgres for now;
// see lib/token-store.js for the swappable interface (Redis later).
export const revokedRefreshTokens = pgTable("revoked_refresh_tokens", {
  jti: text("jti").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
});
