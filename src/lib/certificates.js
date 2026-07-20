import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { trainingIds, schedules, certificates } from "../db/schema.js";

// Stable, human-readable certificate code derived from the enrolment id.
export function generateCertificateCode(enrolmentId) {
  const n = parseInt(createHash("sha1").update(enrolmentId).digest("hex").slice(0, 12), 16);
  const L = "ABCDEFGHIJKLMNPQRSTUVWXYZ"; // drop 'O' to avoid 0/O confusion
  const l1 = L[n % L.length];
  const l2 = L[Math.floor(n / L.length) % L.length];
  const digits = String(n % 10000).padStart(4, "0");
  return `INVL${l1}${l2}${digits}`;
}

// Activity ID printed on the certificate = the schedule's event code; manually
// created trainings have no schedule, so fall back to the training code.
export function activityCodeFor(eventCode, trainingCode) {
  return eventCode ?? trainingCode;
}

// Issue a certificate for an enrolment (idempotent — the partial unique index on
// enrolment_id makes a second call a no-op). Returns the created row, or null if
// one already existed. `runner` is a db or tx handle.
export async function issueCertificate(runner, { enrolmentId, trainingId, surveyResponses }) {
  const [t] = await runner
    .select({ code: trainingIds.code, eventCode: schedules.externalScheduleCode })
    .from(trainingIds)
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(eq(trainingIds.id, trainingId))
    .limit(1);

  const [created] = await runner
    .insert(certificates)
    .values({
      enrolmentId,
      certificateCode: generateCertificateCode(enrolmentId),
      activityCode: activityCodeFor(t?.eventCode, t?.code),
      surveyResponses: surveyResponses ?? {},
    })
    .onConflictDoNothing({ target: certificates.enrolmentId })
    .returning();
  return created ?? null;
}
