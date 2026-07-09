/**
 * Object storage — Cloudflare R2 (S3-compatible) via the AWS SDK.
 *
 * Used for profile photos (and future file uploads). Uploads use short-lived
 * presigned PUT URLs so file bytes go straight from the browser to R2 — our
 * API never proxies them. Reads use presigned GET URLs so the bucket can stay
 * private. All helpers return null when storage isn't configured; callers
 * surface a 503.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

// Prefer the canonical account endpoint derived from R2_ACCOUNT_ID
// (https://<account>.r2.cloudflarestorage.com). With forcePathStyle the bucket
// goes in the path — avoids a double-bucket URL when a configured endpoint
// already includes the bucket as a subdomain.
function resolveEndpoint() {
  if (env.R2_ACCOUNT_ID) return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return env.S3_API_ENDPOINT || env.R2_ENDPOINT || null;
}

export function storageConfigured() {
  return Boolean(
    env.R2_BUCKET &&
      resolveEndpoint() &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY
  );
}

let client = null;
function getClient() {
  if (!storageConfigured()) return null;
  if (client) return client;
  client = new S3Client({
    region: "auto", // R2 ignores region but the SDK requires one
    endpoint: resolveEndpoint(),
    forcePathStyle: true, // bucket in path, not subdomain (correct for R2)
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

// Presigned PUT — the browser uploads directly to R2 with this URL.
export async function presignPut(key, contentType, expiresIn = 300) {
  const c = getClient();
  if (!c) return null;
  return getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

// Presigned GET — a temporary readable URL for a private object.
export async function presignGet(key, expiresIn = 3600) {
  const c = getClient();
  if (!c || !key) return null;
  return getSignedUrl(c, new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
    expiresIn,
  });
}
