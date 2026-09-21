/*
 * Admin certificate management.
 *
 * Issuing and releasing are deliberately separate:
 *
 *   generate  — create the certificate row (code, activity id) for a completed
 *               enrolment. A learner submitting the post-training survey also
 *               generates one; this lets an admin do it for learners who never
 *               filled the survey in.
 *   release   — make it visible to the learner. Nothing reaches the learner
 *               portal until this happens, and revoking takes it back.
 *
 * Printed fields (learner name, course title, dates) are derived by join. When
 * one is wrong the admin overrides it on the certificate row, so correcting a
 * misspelt name on one certificate never rewrites the participant record that
 * analytics and other trainings read.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  certificates,
  courses,
  enrolments,
  participants,
  schedules,
  trainingIds,
  users,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import {
  nextCertificateCode,
  courseIdentifierFor,
  modeOfTraining,
  CERTIFICATE_MODES,
} from "../../lib/certificates.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Seats that can hold a certificate. Cancelled/transferred never earn one.
const ELIGIBLE_ENROLMENT_STATUSES = ["confirmed", "completed"];

/**
 * The PMI logo and "certified" wording print only for a certification course.
 *
 * `course_type` is read from the course catalog (`courses`, joined on slug),
 * not from `training_ids.course_type` — the catalog is what the admin curates
 * at /admin/course-catalog, so it is the one place that stays correct.
 */
async function courseTypeFor(runner, courseSlug) {
  if (!courseSlug) return null;
  const [c] = await runner
    .select({ courseType: courses.courseType })
    .from(courses)
    .where(eq(courses.slug, courseSlug))
    .limit(1);
  return c?.courseType ?? null;
}

async function resolveTraining(runner, ref) {
  const [t] = await runner
    .select()
    .from(trainingIds)
    .where(UUID_RE.test(ref) ? eq(trainingIds.id, ref) : eq(trainingIds.code, ref))
    .limit(1);
  if (!t) throw new AppError("Training not found", 404);
  return t;
}

/**
 * Completed trainings, for the admin's picker.
 *
 * Only `completed` trainings appear: a certificate states the learner finished,
 * so offering one for a training still running invites issuing it too early.
 * Each row carries enough counts for the dropdown to show progress at a glance.
 */
export async function listCertifiableTrainings() {
  const rows = await db
    .select({
      id: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      status: trainingIds.status,
      certificationIncluded: trainingIds.certificationIncluded,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      eligible: sql`count(*) FILTER (WHERE ${inArray(enrolments.status, ELIGIBLE_ENROLMENT_STATUSES)})::int`,
      generated: sql`count(${certificates.id})::int`,
      released: sql`count(*) FILTER (WHERE ${certificates.releasedAt} IS NOT NULL)::int`,
      downloads: sql`coalesce(sum(${certificates.downloadCount}), 0)::int`,
    })
    .from(trainingIds)
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.trainingId, trainingIds.id),
        inArray(enrolments.status, ELIGIBLE_ENROLMENT_STATUSES)
      )
    )
    .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
    .where(eq(trainingIds.status, "completed"))
    .groupBy(
      trainingIds.id,
      trainingIds.code,
      trainingIds.title,
      trainingIds.status,
      trainingIds.certificationIncluded,
      schedules.startDate,
      schedules.endDate
    )
    .orderBy(desc(schedules.endDate));

  return {
    trainings: rows.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      // null = the CMS never resolved this course, so we don't claim either way.
      certification_included: r.certificationIncluded ?? null,
      start_date: r.startDate,
      end_date: r.endDate,
      eligible_count: r.eligible,
      generated_count: r.generated,
      released_count: r.released,
      pending_release_count: r.generated - r.released,
      download_count: r.downloads,
    })),
  };
}

/*
 * One learner's certificate line.
 *
 * Footer field names match the printed certificate, which is NOT what the
 * columns are called:
 *   training_id       = TRN-2026-XXXX   (the training's own code)
 *   certificate_code  = INVLJA4446      (the running certificate number)
 *   course_identifier = INL045293       (the schedule/event code, stored as
 *                                        `activity_code` for historical reasons)
 *   pdu_claim_code    = admin-entered
 */
function certificateRow(r) {
  return {
    enrolment_id: r.enrolmentId,
    participant_id: r.participantId,
    email: r.email,
    enrolment_status: r.enrolmentStatus,
    attendance_status: r.attendanceStatus,

    certificate_id: r.certId ?? null,
    certificate_code: r.certCode ?? null,
    training_id: r.trainingCode,
    course_identifier: r.certActivity ?? null,
    generated: !!r.certId,
    generated_at: r.issuedAt ?? null,

    pdus: r.pdus ?? null,
    pdu_claim_code: r.pduClaimCode ?? null,
    mode_of_training: modeOfTraining(r.deliveryMode, r.certificateMode),

    released: !!r.releasedAt,
    released_at: r.releasedAt ?? null,
    released_by: r.releasedByName ?? null,

    download_count: r.downloadCount ?? 0,
    last_downloaded_at: r.lastDownloadedAt ?? null,

    // What prints. Only the learner name is correctable; the course title and
    // session dates always come from the training.
    learner_name: r.learnerNameOverride ?? r.participantName,
    course_title: r.trainingTitle,
    start_date: r.startDate,
    end_date: r.endDate,

    name_override: r.learnerNameOverride ?? null,
    source_learner_name: r.participantName,
  };
}

async function certificateRowsFor(runner, training) {
  const releasedBy = users;
  return runner
    .select({
      enrolmentId: enrolments.id,
      participantId: participants.id,
      participantName: participants.name,
      email: participants.email,
      enrolmentStatus: enrolments.status,
      attendanceStatus: enrolments.attendanceStatus,
      trainingTitle: trainingIds.title,
      trainingCode: trainingIds.code,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      certId: certificates.id,
      certCode: certificates.certificateCode,
      certActivity: certificates.activityCode,
      issuedAt: certificates.issuedAt,
      releasedAt: certificates.releasedAt,
      releasedByName: releasedBy.name,
      downloadCount: certificates.downloadCount,
      lastDownloadedAt: certificates.lastDownloadedAt,
      learnerNameOverride: certificates.learnerNameOverride,
      pdus: certificates.pdus,
      pduClaimCode: certificates.pduClaimCode,
      certificateMode: certificates.certificateMode,
      deliveryMode: trainingIds.deliveryMode,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
    .leftJoin(releasedBy, eq(releasedBy.id, certificates.releasedBy))
    .where(
      and(
        eq(enrolments.trainingId, training.id),
        inArray(enrolments.status, ELIGIBLE_ENROLMENT_STATUSES)
      )
    )
    .orderBy(asc(participants.name));
}

/** Full certificate picture for one training: the header stats plus every learner. */
export async function getTrainingCertificates(trainingRef) {
  const training = await resolveTraining(db, trainingRef);
  const rows = await certificateRowsFor(db, training);
  const list = rows.map(certificateRow);

  const [schedule] = training.scheduleId
    ? await db.select().from(schedules).where(eq(schedules.id, training.scheduleId)).limit(1)
    : [];

  const courseType = await courseTypeFor(db, training.courseSlug);

  return {
    training: {
      id: training.id,
      code: training.code, // printed as "Training ID"
      title: training.title,
      status: training.status,
      certification_included: training.certificationIncluded ?? null,
      // From the course catalog. Drives the PMI logo + "certified" seal.
      course_type: courseType,
      is_certification: courseType === "certification",
      delivery_mode: training.deliveryMode,
      mode_of_training: modeOfTraining(training.deliveryMode, training.certificateMode),
      certificate_mode: training.certificateMode ?? null,
      certificate_mode_options: CERTIFICATE_MODES,
      start_date: schedule?.startDate ?? null,
      end_date: schedule?.endDate ?? null,
      session_dates: schedule?.sessionDates ?? null,
      course_identifier: courseIdentifierFor({
        eventCode: schedule?.externalEventCode,
        eventId: schedule?.externalEventId,
        trainingCode: training.code,
      }),
      // Admin-set, inherited by every certificate generated after they're set.
      pdus: training.pdus ?? null,
      pdu_claim_code: training.pduClaimCode ?? null,
    },
    summary: {
      eligible: list.length,
      generated: list.filter((c) => c.generated).length,
      released: list.filter((c) => c.released).length,
      pending_release: list.filter((c) => c.generated && !c.released).length,
      not_generated: list.filter((c) => !c.generated).length,
      downloaded: list.filter((c) => c.download_count > 0).length,
      total_downloads: list.reduce((n, c) => n + c.download_count, 0),
    },
    certificates: list,
  };
}

/**
 * Create certificate rows for eligible seats that don't have one.
 *
 * Idempotent: seats that already hold a certificate are skipped, so running it
 * twice changes nothing. Generating does NOT release — the learner still sees
 * nothing until an admin releases it.
 */
export async function generateCertificates(adminId, trainingRef, enrolmentIds, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);
    if (training.status !== "completed") {
      throw new AppError(
        `This training is ${training.status}. Certificates can only be generated for a completed training.`,
        409
      );
    }

    const [schedule] = training.scheduleId
      ? await tx.select().from(schedules).where(eq(schedules.id, training.scheduleId)).limit(1)
      : [];
    const activityCode = courseIdentifierFor({
      eventCode: schedule?.externalEventCode,
      eventId: schedule?.externalEventId,
      trainingCode: training.code,
    });

    const targets = await tx
      .select({ id: enrolments.id })
      .from(enrolments)
      .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
      .where(
        and(
          eq(enrolments.trainingId, training.id),
          inArray(enrolments.status, ELIGIBLE_ENROLMENT_STATUSES),
          isNull(certificates.id),
          ...(enrolmentIds?.length ? [inArray(enrolments.id, enrolmentIds)] : [])
        )
      );

    // PDUs and the claim code print on the certificate, so they must be set
    // before any is generated — otherwise the first batch goes out blank and
    // has to be regenerated. Refused with the reason rather than silently
    // issuing an incomplete certificate.
    if (training.pdus == null || !training.pduClaimCode) {
      const missing = [
        training.pdus == null ? "PDUs" : null,
        !training.pduClaimCode ? "PDU claim code" : null,
      ].filter(Boolean);
      throw new AppError(
        `Set the ${missing.join(" and ")} for this training before generating certificates.`,
        409,
        { code: "pdu_details_missing", missing }
      );
    }

    let created = 0;
    for (const t of targets) {
      const [row] = await tx
        .insert(certificates)
        .values({
          enrolmentId: t.id,
          certificateCode: await nextCertificateCode(tx),
          activityCode,
          pdus: training.pdus,
          pduClaimCode: training.pduClaimCode,
          certificateMode: training.certificateMode,
          surveyResponses: {}, // admin-generated: no survey was filled in
        })
        .onConflictDoNothing({ target: certificates.enrolmentId })
        .returning({ id: certificates.id });
      if (row) created += 1;
    }

    await writeAudit(tx, {
      entityType: "training_id",
      entityId: training.id,
      action: "certificates_generated",
      actorId: adminId,
      after: { created, requested: enrolmentIds?.length ?? "all" },
      ipAddress: ip,
    });

    return { training_code: training.code, generated: created, skipped: targets.length - created };
  });
}

/**
 * Release certificates so learners can see them.
 *
 * With `enrolmentIds` releases just those; without, releases every generated
 * but unreleased certificate on the training. Already-released rows are left
 * alone so a bulk release never resets who released it or when.
 */
export async function releaseCertificates(adminId, trainingRef, enrolmentIds, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);

    const scope = await tx
      .select({ certId: certificates.id })
      .from(certificates)
      .innerJoin(enrolments, eq(enrolments.id, certificates.enrolmentId))
      .where(
        and(
          eq(enrolments.trainingId, training.id),
          isNull(certificates.releasedAt),
          ...(enrolmentIds?.length ? [inArray(enrolments.id, enrolmentIds)] : [])
        )
      );

    if (scope.length === 0) {
      return { training_code: training.code, released: 0, already_released: true };
    }

    const ids = scope.map((s) => s.certId);
    const done = await tx
      .update(certificates)
      .set({ releasedAt: new Date(), releasedBy: adminId })
      .where(inArray(certificates.id, ids))
      .returning({ id: certificates.id });

    await writeAudit(tx, {
      entityType: "training_id",
      entityId: training.id,
      action: "certificates_released",
      actorId: adminId,
      after: { released: done.length, scope: enrolmentIds?.length ? "selected" : "all" },
      ipAddress: ip,
    });

    return { training_code: training.code, released: done.length };
  });
}

/** Take a released certificate back out of the learner's view. */
export async function revokeCertificate(adminId, certificateId, reason, ip) {
  return db.transaction(async (tx) => {
    const [cert] = await tx
      .select()
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!cert) throw new AppError("Certificate not found", 404);
    if (!cert.releasedAt) throw new AppError("Certificate is not released", 409);

    await tx
      .update(certificates)
      .set({ releasedAt: null, releasedBy: null })
      .where(eq(certificates.id, certificateId));

    await writeAudit(tx, {
      entityType: "certificate",
      entityId: certificateId,
      action: "certificate_revoked",
      actorId: adminId,
      before: { released_at: cert.releasedAt },
      after: { released_at: null },
      reason: reason ?? null,
      ipAddress: ip,
    });

    return { certificate_id: certificateId, released: false };
  });
}

/**
 * Correct what a certificate prints.
 *
 * Only the certificate row changes. Sending `null` for an override clears it
 * and the printed value falls back to the joined source, so a mistaken edit is
 * always reversible without knowing the original.
 */
export async function updateCertificate(adminId, certificateId, body, ip) {
  return db.transaction(async (tx) => {
    const [cert] = await tx
      .select()
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!cert) throw new AppError("Certificate not found", 404);

    // Course title and session dates are deliberately absent: they come from
    // the training, so a certificate can never disagree with what it certifies.
    // Fix those on the training itself.
    const FIELDS = {
      learner_name: "learnerNameOverride",
      certificate_code: "certificateCode",
      course_identifier: "activityCode",
      pdus: "pdus",
      pdu_claim_code: "pduClaimCode",
      issued_at: "issuedAt",
    };

    const set = {};
    for (const [key, col] of Object.entries(FIELDS)) {
      if (key in body) set[col] = body[key];
    }
    if (Object.keys(set).length === 0) throw new AppError("No fields to update", 422);

    // The code is printed and used to look a certificate up, so it must stay
    // unique. Checked here to return 409 rather than a raw constraint error.
    if (set.certificateCode && set.certificateCode !== cert.certificateCode) {
      const [clash] = await tx
        .select({ id: certificates.id })
        .from(certificates)
        .where(eq(certificates.certificateCode, set.certificateCode))
        .limit(1);
      if (clash) throw new AppError("That certificate code is already in use", 409);
    }
    if (set.issuedAt) set.issuedAt = new Date(set.issuedAt);

    const [updated] = await tx
      .update(certificates)
      .set(set)
      .where(eq(certificates.id, certificateId))
      .returning();

    await writeAudit(tx, {
      entityType: "certificate",
      entityId: certificateId,
      action: "certificate_updated",
      actorId: adminId,
      before: Object.fromEntries(Object.keys(set).map((k) => [k, cert[k] ?? null])),
      after: Object.fromEntries(Object.keys(set).map((k) => [k, updated[k] ?? null])),
      ipAddress: ip,
    });

    return { certificate_id: certificateId, updated: Object.keys(set).length };
  });
}

/**
 * Set the PDUs and PMI claim code for a training.
 *
 * Training-level, not per-learner: every learner on a cohort earns the same
 * PDUs and claims against the same code. Certificates already generated are
 * updated too, so correcting a typo fixes the ones already issued rather than
 * leaving a cohort split between two values.
 */
export async function setTrainingPdus(adminId, trainingRef, { pdus, pdu_claim_code, certificate_mode }, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);

    await tx
      .update(trainingIds)
      .set({
        pdus,
        pduClaimCode: pdu_claim_code,
        ...(certificate_mode !== undefined ? { certificateMode: certificate_mode } : {}),
        updatedAt: new Date(),
      })
      .where(eq(trainingIds.id, training.id));

    const synced = await tx
      .update(certificates)
      .set({
        pdus,
        pduClaimCode: pdu_claim_code,
        ...(certificate_mode !== undefined ? { certificateMode: certificate_mode } : {}),
      })
      .where(
        inArray(
          certificates.enrolmentId,
          tx.select({ id: enrolments.id }).from(enrolments).where(eq(enrolments.trainingId, training.id))
        )
      )
      .returning({ id: certificates.id });

    await writeAudit(tx, {
      entityType: "training_id",
      entityId: training.id,
      action: "certificate_pdus_set",
      actorId: adminId,
      before: { pdus: training.pdus, pdu_claim_code: training.pduClaimCode, certificate_mode: training.certificateMode },
      after: { pdus, pdu_claim_code, certificate_mode: certificate_mode ?? training.certificateMode },
      ipAddress: ip,
    });

    return {
      training_code: training.code,
      pdus,
      pdu_claim_code,
      certificate_mode: certificate_mode ?? training.certificateMode ?? null,
      certificates_updated: synced.length,
    };
  });
}

/** Flat list across every training — powers the overview table. */
export async function listAllCertificates() {
  const rows = await db
    .select({
      certId: certificates.id,
      certCode: certificates.certificateCode,
      activityCode: certificates.activityCode,
      issuedAt: certificates.issuedAt,
      releasedAt: certificates.releasedAt,
      downloadCount: certificates.downloadCount,
      lastDownloadedAt: certificates.lastDownloadedAt,
      learnerNameOverride: certificates.learnerNameOverride,
      courseTitleOverride: certificates.courseTitleOverride,
      participantName: participants.name,
      email: participants.email,
      trainingCode: trainingIds.code,
      trainingTitle: trainingIds.title,
      certificationIncluded: trainingIds.certificationIncluded,
    })
    .from(certificates)
    .innerJoin(enrolments, eq(enrolments.id, certificates.enrolmentId))
    .innerJoin(participants, eq(participants.id, enrolments.participantId))
    .innerJoin(trainingIds, eq(trainingIds.id, enrolments.trainingId))
    .orderBy(desc(certificates.issuedAt));

  return {
    certificates: rows.map((r) => ({
      certificate_id: r.certId,
      certificate_code: r.certCode,
      activity_id: r.activityCode,
      learner_name: r.learnerNameOverride ?? r.participantName,
      email: r.email,
      training_code: r.trainingCode,
      course_title: r.courseTitleOverride ?? r.trainingTitle,
      certification_included: r.certificationIncluded ?? null,
      issued_at: r.issuedAt,
      released: !!r.releasedAt,
      released_at: r.releasedAt,
      download_count: r.downloadCount,
      last_downloaded_at: r.lastDownloadedAt,
    })),
  };
}
