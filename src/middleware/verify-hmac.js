import crypto from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

/**
 * Verifies an HMAC-signed request body (for machine-to-machine callers like the
 * CRM). The caller sends `X-Signature: sha256=<hex>` where the hex is
 * HMAC-SHA256 of the *raw* request body keyed by ORDER_HMAC_SECRET. We recompute
 * over the captured raw body (see express.json `verify` in index.js) and compare
 * with a timing-safe equal.
 */
export function verifyHmac(req, _res, next) {
  const provided = req.get("x-signature");
  const raw = req.rawBody;
  if (!provided || !raw || raw.length === 0) {
    return next(new AppError("Missing request signature", 401));
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", env.ORDER_HMAC_SECRET).update(raw).digest("hex");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new AppError("Invalid request signature", 401));
  }
  next();
}
