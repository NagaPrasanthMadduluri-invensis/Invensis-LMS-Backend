/**
 * One-shot backfill: recompute every enrolment's overall attendance_status from
 * its per-session attendance records, so any stale value is corrected.
 *
 * Why this is needed: attendance_status was previously only recomputed when a
 * trainer marked attendance. Rescheduling a training changes its session set
 * (a shorter schedule drops surplus days), which moves the denominator behind
 * the stored status without recomputing it — leaving, e.g., a learner who
 * attended every remaining day frozen at "partial". The reschedule path now
 * recomputes automatically (admin.service.js → rescheduleTraining); this script
 * fixes rows that drifted before that fix shipped.
 *
 * Uses the SAME recompute logic the app uses (lib/attendance.js), so it can
 * never disagree with live behaviour. Idempotent — safe to run any number of
 * times; only rows whose stored value differs from the recomputed one change.
 *
 *   node src/db/backfill-attendance-status.js
 */
import { notInArray } from "drizzle-orm";
import { db } from "../config/db.js";
import { enrolments } from "./schema.js";
import { recomputeEnrolmentAttendance } from "../lib/attendance.js";

async function main() {
  // Every enrolment that can hold attendance (cancelled/transferred never do).
  const rows = await db
    .select({
      trainingId: enrolments.trainingId,
      participantId: enrolments.participantId,
      before: enrolments.attendanceStatus,
    })
    .from(enrolments)
    .where(notInArray(enrolments.status, ["cancelled", "transferred"]));

  console.log(`Recomputing attendance_status for ${rows.length} enrolment(s)…\n`);

  const changes = [];
  for (const r of rows) {
    const after = await recomputeEnrolmentAttendance(db, r.trainingId, r.participantId);
    if (after !== r.before) {
      changes.push({ trainingId: r.trainingId, participantId: r.participantId, before: r.before, after });
    }
  }

  console.log(`Done. ${changes.length} enrolment(s) corrected:`);
  for (const c of changes) {
    console.log(`  ${c.trainingId} / ${c.participantId}: ${c.before} -> ${c.after}`);
  }
  if (changes.length === 0) console.log("  (nothing to change — all stored values already match their records)");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
