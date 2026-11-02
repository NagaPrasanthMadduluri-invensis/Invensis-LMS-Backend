/**
 * Daily job: remind learners whose exam voucher expires in about a month.
 *
 * Business rule: a booked voucher gets ONE reminder email once it enters its
 * final month (expires_at is between today and a month from today) and hasn't
 * been reminded yet. `reminder_sent_at` is stamped on send so it never repeats,
 * and re-booking (which clears that stamp and sets a fresh window) lets a new
 * reminder fire for the new expiry. Already-expired vouchers are skipped.
 *
 *   node src/jobs/voucher-expiry-reminders.js            # send
 *   node src/jobs/voucher-expiry-reminders.js --dry-run  # list, send nothing
 */
import { and, eq, isNull, sql, asc } from "drizzle-orm";
import { db, pool } from "../config/db.js";
import { examVoucherBookings, enrolments, participants, trainingIds } from "../db/schema.js";
import { sendVoucherExpiryReminderEmail } from "../lib/mailer.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const rows = await db
    .select({
      bookingId: examVoucherBookings.id,
      name: participants.name,
      email: participants.email,
      courseName: trainingIds.title,
      expiresAt: examVoucherBookings.expiresAt,
    })
    .from(examVoucherBookings)
    .innerJoin(enrolments, eq(enrolments.id, examVoucherBookings.enrolmentId))
    .innerJoin(participants, eq(participants.id, enrolments.participantId))
    .innerJoin(trainingIds, eq(trainingIds.id, enrolments.trainingId))
    .where(
      and(
        eq(examVoucherBookings.status, "booked"),
        isNull(examVoucherBookings.reminderSentAt),
        // Within the final month: today ≤ expiry ≤ today + 1 month.
        sql`${examVoucherBookings.expiresAt} >= CURRENT_DATE`,
        sql`${examVoucherBookings.expiresAt} <= CURRENT_DATE + INTERVAL '1 month'`
      )
    )
    .orderBy(asc(examVoucherBookings.expiresAt));

  console.log(
    `[voucher-reminders] ${rows.length} voucher(s) entering their final month` +
      (DRY_RUN ? " (dry run — sending nothing)" : "")
  );

  let sent = 0;
  const failed = [];
  for (const r of rows) {
    const label = `${r.email} → ${r.courseName} (expires ${r.expiresAt})`;
    if (DRY_RUN) {
      console.log(`  would send: ${label}`);
      continue;
    }
    if (!r.email) {
      console.log(`  skip (no email): ${label}`);
      continue;
    }
    try {
      await sendVoucherExpiryReminderEmail(
        { name: r.name, email: r.email },
        { courseName: r.courseName, expiresOn: r.expiresAt }
      );
      await db
        .update(examVoucherBookings)
        .set({ reminderSentAt: new Date() })
        .where(eq(examVoucherBookings.id, r.bookingId));
      sent += 1;
      console.log(`  sent: ${label}`);
    } catch (err) {
      failed.push({ email: r.email, error: err.message });
      console.error(`  FAILED: ${label} — ${err.message}`);
    }
  }

  console.log(`[voucher-reminders] done. sent=${sent} failed=${failed.length}`);
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[voucher-reminders] fatal:", err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
