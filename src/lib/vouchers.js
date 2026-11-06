import { inArray } from "drizzle-orm";
import { db } from "../config/db.js";
import { examVoucherBookings } from "../db/schema.js";

/**
 * Validate an admin-chosen voucher expiry date. Must be a real calendar day in
 * `YYYY-MM-DD` form and today or later — a voucher can't expire in the past.
 * The day is compared in UTC, matching how `expires_at` (a plain date) is stored
 * and how the reminder job's `CURRENT_DATE` comparisons behave.
 */
export function isValidExpiryDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, day] = str.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  // Reject rolled-over dates like 2026-02-31 (Date would silently normalise).
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) {
    return false;
  }
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return d.getTime() >= todayUTC;
}

/**
 * Shape a raw booking row into the object the portals consume. `null` in →
 * `null` out (no booking yet), so callers can attach it directly to a seat.
 */
export function serializeVoucher(row) {
  if (!row) return null;
  return {
    status: row.status,
    booked: row.status === "booked",
    validity_months: row.validityMonths ?? null,
    booked_at: row.bookedAt ?? null,
    expires_at: row.expiresAt ?? null,
    result: row.result ?? null,
    result_updated_at: row.resultUpdatedAt ?? null,
  };
}

/**
 * Batch-resolve voucher bookings for many enrolments at once, to attach them to
 * a roster without a query per row. Returns a Map of enrolmentId -> serialized
 * voucher; enrolments with no booking are simply absent. Nullish ids ignored.
 */
export async function vouchersByEnrolmentIds(enrolmentIds) {
  const ids = [...new Set((enrolmentIds ?? []).filter(Boolean))];
  const map = new Map();
  if (ids.length === 0) return map;

  const rows = await db
    .select()
    .from(examVoucherBookings)
    .where(inArray(examVoucherBookings.enrolmentId, ids));

  for (const r of rows) map.set(r.enrolmentId, serializeVoucher(r));
  return map;
}
