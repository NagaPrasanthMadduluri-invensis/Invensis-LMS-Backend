import { inArray } from "drizzle-orm";
import { db } from "../config/db.js";
import { examVoucherBookings } from "../db/schema.js";

/**
 * Validity windows an admin may pick for an exam voucher, in whole months. The
 * dropdown in the portal and the server-side validation both read this list, so
 * the two can never drift. Order is the order shown.
 */
export const VOUCHER_VALIDITY_MONTHS = [3, 6, 12];

export function isValidValidityMonths(n) {
  return VOUCHER_VALIDITY_MONTHS.includes(Number(n));
}

/**
 * Expiry day for a voucher booked on `bookedAt` (a Date) for `months` months.
 * Returns a `YYYY-MM-DD` string — expiry is a calendar day, not an instant.
 * Adding months can overflow a short month (e.g. booking on the 31st); JS Date
 * rolls that into the next month, which is the conventional, lenient behaviour.
 */
export function computeExpiryDate(bookedAt, months) {
  const d = new Date(bookedAt);
  d.setMonth(d.getMonth() + Number(months));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
