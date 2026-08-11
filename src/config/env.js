import "dotenv/config";
import { z } from "zod";

// Parses "true"/"false"/"1"/"0" env strings into real booleans.
// (z.coerce.boolean() would turn the string "false" into true.)
const boolFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().url(),
  // TLS to the database (managed DBs like RDS):
  //   disable   → no TLS (local dev)
  //   require   → TLS with cert verification (needs the CA in the trust store)
  //   no-verify → TLS without cert verification (simplest for RDS)
  DB_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  // Shared secret for HMAC-signed integration requests (xCRM → POST /api/orders)
  ORDER_HMAC_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_SECURE: boolFromEnv.default(false),

  // Defaults for fields the xCRM order payload does not carry
  SCHEDULE_DEFAULT_CAPACITY: z.coerce.number().int().positive().default(30),
  SCHEDULE_DEFAULT_MIN_SEATS: z.coerce.number().int().positive().default(1),

  // Account-setup / password-reset email flow.
  // FRONTEND_URL is the base for the emailed set-password / reset-password links.
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  SETUP_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(72),
  // SMTP (Nodemailer). If SMTP_HOST is unset the mailer falls back to logging
  // the email to the console — dev/CI works without real credentials.
  MAIL_FROM: z.string().default("Invensis Learning Portal <no-reply@invensis.net>"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: boolFromEnv.default(false),

  // Object storage (Cloudflare R2, S3-compatible) for profile photos etc.
  // All optional — if unset, file-upload endpoints return 503 (not configured).
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  S3_API_ENDPOINT: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment configuration:",
    parsed.error.flatten().fieldErrors
  );
  process.exit(1);
}

export const env = parsed.data;
