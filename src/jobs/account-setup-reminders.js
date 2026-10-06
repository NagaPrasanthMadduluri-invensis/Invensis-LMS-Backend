/**
 * Daily job: remind learners who still haven't set up their account about an
 * imminent training.
 *
 * Business rule: from 2 days before a training starts until it starts, any
 * enrolled learner whose account is active but has no password yet gets a
 * reminder email with a fresh set-password link. Run once a day by cron, it
 * sends on the 2-days-before and 1-day-before marks (and stops once they set a
 * password or the training starts). A learner enrolled in more than one
 * upcoming training is reminded once per run, referencing the nearest one.
 *
 *   node src/jobs/account-setup-reminders.js            # send
 *   node src/jobs/account-setup-reminders.js --dry-run  # list, send nothing
 */
import { and, eq, isNull, inArray, notInArray, asc, sql } from "drizzle-orm";
import { db, pool } from "../config/db.js";
import { trainingIds, schedules, enrolments, participants, users } from "../db/schema.js";
import { sendAccountSetupReminder } from "../lib/account-setup.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      trainingTitle: trainingIds.title,
      trainingCode: trainingIds.code,
      startDate: schedules.startDate,
    })
    .from(enrolments)
    .innerJoin(trainingIds, eq(trainingIds.id, enrolments.trainingId))
    .innerJoin(schedules, eq(schedules.id, trainingIds.scheduleId))
    .innerJoin(participants, eq(participants.id, enrolments.participantId))
    .innerJoin(users, eq(users.id, participants.userId))
    .where(
      and(
        inArray(trainingIds.status, ["active", "ongoing"]),
        notInArray(enrolments.status, ["cancelled", "transferred"]),
        eq(users.isActive, true),
        isNull(users.passwordHash),
        // > today and within 2 days: the 2-days-before and 1-day-before marks.
        sql`${schedules.startDate} > CURRENT_DATE`,
        sql`${schedules.startDate} <= CURRENT_DATE + 2`
      )
    )
    // Nearest training first, so the per-user dedupe keeps the most urgent one.
    .orderBy(asc(schedules.startDate));

  // One reminder per user per run (nearest upcoming training wins).
  const byUser = new Map();
  for (const r of rows) if (!byUser.has(r.userId)) byUser.set(r.userId, r);
  const targets = [...byUser.values()];

  console.log(
    `[setup-reminders] ${targets.length} learner(s) need a reminder` +
      (DRY_RUN ? " (dry run — sending nothing)" : "")
  );

  let sent = 0;
  const failed = [];
  for (const t of targets) {
    const label = `${t.email} → ${t.trainingCode} (${t.startDate})`;
    if (DRY_RUN) {
      console.log(`  would send: ${label}`);
      continue;
    }
    try {
      await sendAccountSetupReminder(
        { id: t.userId, name: t.name, email: t.email },
        { trainingTitle: t.trainingTitle, startDate: t.startDate }
      );
      sent += 1;
      console.log(`  sent: ${label}`);
    } catch (err) {
      failed.push({ email: t.email, error: err.message });
      console.error(`  FAILED: ${label} — ${err.message}`);
    }
  }

  console.log(`[setup-reminders] done. sent=${sent} failed=${failed.length}`);
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[setup-reminders] fatal:", err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
