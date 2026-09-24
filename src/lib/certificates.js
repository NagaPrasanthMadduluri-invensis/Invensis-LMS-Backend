import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { trainingIds, schedules, certificates } from "../db/schema.js";

const CODE_PREFIX = "INVLJA";

/**
 * Next certificate code from the shared counter: INVLJA4447, INVLJA4448, …
 *
 * A running number, not a hash of the enrolment id: certificates are audited as
 * a series, and the sequence continues the numbering already issued outside
 * this system rather than restarting — the first code here is INVLJA4447. The
 * counter lives in Postgres (`certificate_code_seq`), so concurrent issues can
 * never collide — two requests calling nextval always get different numbers,
 * which a generate-then-check would not guarantee.
 *
 * Padded to 4 digits; past 9999 it simply grows to 5, which keeps the codes
 * unique and sortable rather than wrapping back onto an issued one.
 */
export async function nextCertificateCode(runner) {
  const res = await runner.execute(sql`SELECT nextval('certificate_code_seq')::bigint AS n`);
  const n = (res.rows ?? res)[0].n;
  return `${CODE_PREFIX}${String(n).padStart(4, "0")}`;
}

// Legacy: codes issued before the counter were derived from the enrolment id.
// Kept so an old code can still be recomputed and verified.
export function generateCertificateCode(enrolmentId) {
  const n = parseInt(createHash("sha1").update(enrolmentId).digest("hex").slice(0, 12), 16);
  const L = "ABCDEFGHIJKLMNPQRSTUVWXYZ"; // drop 'O' to avoid 0/O confusion
  const l1 = L[n % L.length];
  const l2 = L[Math.floor(n / L.length) % L.length];
  const digits = String(n % 10000).padStart(4, "0");
  return `INVL${l1}${l2}${digits}`;
}

/**
 * Wording an admin can pick for "…which took place on …, via <mode>."
 *
 * Kept separate from `delivery_mode`, which is the operational routing value:
 * the two legitimately differ, e.g. a `virtual` training certified as
 * "Live virtual class".
 */
export const CERTIFICATE_MODES = [
  "Live virtual class",
  "in-person onsite",
  "online classroom",
  "onsite classroom",
];

/**
 * How the training ran, as it reads on the certificate. `certificateMode` is
 * the admin's choice and wins; otherwise the wording is derived from the
 * delivery mode so an older training still prints something sensible.
 */
export function modeOfTraining(deliveryMode, certificateMode = null) {
  if (certificateMode) return certificateMode;
  return {
    virtual: "online classroom",
    online: "online classroom",
    classroom: "onsite classroom",
    onsite: "in-person onsite",
    in_person: "in-person onsite",
    hybrid: "online classroom",
  }[deliveryMode] ?? "online classroom";
}

/**
 * "Course Identifier" printed on the certificate — the CMS event code
 * (e.g. INL045293).
 *
 * Resolution order matters. `external_event_code` is the code the CMS sent and
 * is authoritative. Older schedules predate that column, so it is derived from
 * the numeric event id in the CMS's own format ("INL" + 6 digits) — 69541
 * becomes INL069541. `external_schedule_code` is deliberately NOT used: that is
 * the schedule's own id ("1028455") and printing it puts the wrong number on a
 * certificate. A training with no schedule at all falls back to its own code.
 *
 * Stored on `certificates.activity_code` for historical reasons; the printed
 * label is Course Identifier, not Activity ID.
 */
/**
 * Which document a training yields: a Certificate of Training, or a Letter of
 * Course Attendance.
 *
 * When a certification course INCLUDES the certification, the awarding body
 * (PMI, PeopleCert, …) issues the qualification — Invensis can only attest that
 * the learner attended, never that they achieved anything. So
 * `course_type = certification AND certification_included` yields an attendance
 * letter; everything else yields a Certificate of Training.
 *
 * Both inputs come from the course catalog, synced from the CMS. This is the
 * single home for the rule: the public verification page, the learner's own
 * training list and the generated PDF must never disagree about what a learner
 * is being given.
 *
 * @returns {"attendance_letter" | "certificate"}
 */
export function credentialTypeFor({ courseType, certificationIncluded } = {}) {
  return courseType === "certification" && certificationIncluded === true
    ? "attendance_letter"
    : "certificate";
}

export function courseIdentifierFor({ eventCode, eventId, trainingCode } = {}) {
  if (eventCode) return eventCode;
  if (eventId != null && Number.isFinite(Number(eventId))) {
    return `INL${String(Number(eventId)).padStart(6, "0")}`;
  }
  return trainingCode ?? null;
}

// Back-compat wrapper for callers that only have the two legacy values.
export function activityCodeFor(eventCode, trainingCode) {
  return courseIdentifierFor({ eventCode, trainingCode });
}

// Issue a certificate for an enrolment (idempotent — the partial unique index on
// enrolment_id makes a second call a no-op). Returns the created row, or null if
// one already existed. `runner` is a db or tx handle.
export async function issueCertificate(runner, { enrolmentId, trainingId, surveyResponses }) {
  const [t] = await runner
    .select({
      code: trainingIds.code,
      eventCode: schedules.externalEventCode,
      eventId: schedules.externalEventId,
      pdus: trainingIds.pdus,
      pduClaimCode: trainingIds.pduClaimCode,
      certificateMode: trainingIds.certificateMode,
      trademarkName: trainingIds.trademarkName,
    })
    .from(trainingIds)
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(eq(trainingIds.id, trainingId))
    .limit(1);

  const [created] = await runner
    .insert(certificates)
    .values({
      enrolmentId,
      certificateCode: await nextCertificateCode(runner),
      activityCode: courseIdentifierFor({ eventCode: t?.eventCode, eventId: t?.eventId, trainingCode: t?.code }),
      // Snapshot, not join — a certificate keeps the PDUs it was issued with
      // even if the training's figure is corrected for a later cohort.
      pdus: t?.pdus ?? null,
      pduClaimCode: t?.pduClaimCode ?? null,
      certificateMode: t?.certificateMode ?? null,
      trademarkName: t?.trademarkName ?? null,
      surveyResponses: surveyResponses ?? {},
    })
    .onConflictDoNothing({ target: certificates.enrolmentId })
    .returning();
  return created ?? null;
}
