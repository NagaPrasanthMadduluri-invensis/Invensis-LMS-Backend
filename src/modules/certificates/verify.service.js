/*
 * Public certificate verification.
 *
 * Unauthenticated by design — anyone holding a printed certificate (or scanning
 * its QR code) must be able to confirm it. That makes what is returned a
 * deliberate choice, not an oversight: only what is already printed on the
 * certificate face is exposed. No email, no participant id, no order or payment
 * detail, and no way to enumerate — the lookup is by exact code only.
 *
 * An unreleased certificate does not verify. Releasing is what makes a
 * certificate real; a generated-but-withheld one must look exactly like one
 * that was never issued.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  certificates,
  courses,
  enrolments,
  participants,
  schedules,
  trainingIds,
} from "../../db/schema.js";
import { courseIdentifierFor, credentialTypeFor, modeOfTraining } from "../../lib/certificates.js";

/**
 * Look a certificate up by the code printed on it.
 *
 * Accepts the Certificate ID (INVLJA4447) or the Training ID (TRN-2026-0024),
 * matching the two identifiers a holder can read off the page. Comparison is
 * case-insensitive and trimmed, because people type what they see.
 *
 * `name` is an optional stricter check: when supplied it must match the holder,
 * so a guessed code alone doesn't confirm someone's name. It never widens a
 * match, only narrows it.
 */
export async function verifyCertificate(rawCode, rawName) {
  const code = String(rawCode ?? "").trim();
  if (!code) return { found: false, query: code };

  const [row] = await db
    .select({
      certificateCode: certificates.certificateCode,
      activityCode: certificates.activityCode,
      issuedAt: certificates.issuedAt,
      releasedAt: certificates.releasedAt,
      pdus: certificates.pdus,
      pduClaimCode: certificates.pduClaimCode,
      certificateMode: certificates.certificateMode,
      learnerNameOverride: certificates.learnerNameOverride,
      courseTitleOverride: certificates.courseTitleOverride,
      participantName: participants.name,
      trainingCode: trainingIds.code,
      trainingTitle: trainingIds.title,
      deliveryMode: trainingIds.deliveryMode,
      trainingStatus: trainingIds.status,
      courseType: courses.courseType,
      certificationIncluded: courses.certificationIncluded,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      sessionDates: schedules.sessionDates,
      eventCode: schedules.externalEventCode,
      eventId: schedules.externalEventId,
    })
    .from(certificates)
    .innerJoin(enrolments, eq(enrolments.id, certificates.enrolmentId))
    .innerJoin(participants, eq(participants.id, enrolments.participantId))
    .innerJoin(trainingIds, eq(trainingIds.id, enrolments.trainingId))
    .leftJoin(schedules, eq(schedules.id, trainingIds.scheduleId))
    .leftJoin(courses, eq(courses.slug, trainingIds.courseSlug))
    .where(
      and(
        or(
          sql`upper(${certificates.certificateCode}) = upper(${code})`,
          sql`upper(${trainingIds.code}) = upper(${code})`
        ),
        // Withheld certificates must not verify.
        sql`${certificates.releasedAt} IS NOT NULL`
      )
    )
    .limit(1);

  if (!row) return { found: false, query: code };

  const holder = row.learnerNameOverride ?? row.participantName;

  // Optional name check. Compared on collapsed whitespace and case so "  fernando
  // BASTO jr " matches, but a different person does not.
  const name = String(rawName ?? "").trim();
  if (name) {
    const norm = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (norm(name) !== norm(holder)) return { found: false, query: code, name_mismatch: true };
  }

  return {
    found: true,
    certificate: {
      certificate_id: row.certificateCode,
      training_id: row.trainingCode,
      course_identifier: courseIdentifierFor({
        eventCode: row.eventCode,
        eventId: row.eventId,
        trainingCode: row.trainingCode,
      }),
      pdu_claim_code: row.pduClaimCode ?? null,
      pdus: row.pdus ?? null,
      holder_name: holder,
      // The override, so the verification page names the course exactly as the
      // printed document does — otherwise scanning a certificate would show a
      // different course name than the certificate itself.
      course_title: row.courseTitleOverride ?? row.trainingTitle,
      training_mode: modeOfTraining(row.deliveryMode, row.certificateMode),
      session_dates: row.sessionDates ?? null,
      start_date: row.startDate ?? null,
      end_date: row.endDate ?? null,
      issued_at: row.issuedAt,
      is_certification: row.courseType === "certification",
      // Certificate of Training vs Letter of Course Attendance — see
      // `credentialTypeFor`, which is the one home for that rule.
      credential_type: credentialTypeFor({
        courseType: row.courseType,
        certificationIncluded: row.certificationIncluded,
      }),
      // Revoking clears released_at, so anything returned here is live.
      status: "active",
      verified_at: new Date().toISOString(),
    },
  };
}
