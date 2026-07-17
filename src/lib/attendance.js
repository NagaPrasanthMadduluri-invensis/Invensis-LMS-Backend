import { and, eq, inArray } from "drizzle-orm";
import { trainingSessions, attendanceRecords, enrolments } from "../db/schema.js";

/**
 * Recompute an enrolment's overall attendance_status from its per-session
 * records and write it back (this is what the admin analytics read).
 *
 * Heuristic (the pay-once-attend-twice business rule, OI-01, is still pending):
 *   attended = present | late; excused is neutral (dropped from the denominator).
 *   nothing marked -> not_marked, attended all -> present, some -> partial,
 *   none -> absent.
 */
export async function recomputeEnrolmentAttendance(runner, trainingId, participantId) {
  const sessions = await runner
    .select({ id: trainingSessions.id })
    .from(trainingSessions)
    .where(eq(trainingSessions.trainingId, trainingId));
  const sessionIds = sessions.map((s) => s.id);

  let status = "not_marked";
  if (sessionIds.length > 0) {
    const recs = await runner
      .select({ status: attendanceRecords.status })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.participantId, participantId),
          inArray(attendanceRecords.sessionId, sessionIds)
        )
      );
    if (recs.length > 0) {
      const attended = recs.filter((r) => r.status === "present" || r.status === "late").length;
      const excused = recs.filter((r) => r.status === "excused").length;
      const denom = sessionIds.length - excused;
      if (denom <= 0 || attended >= denom) status = "present";
      else if (attended > 0) status = "partial";
      else status = "absent";
    }
  }

  await runner
    .update(enrolments)
    .set({ attendanceStatus: status, updatedAt: new Date() })
    .where(and(eq(enrolments.trainingId, trainingId), eq(enrolments.participantId, participantId)));

  return status;
}
