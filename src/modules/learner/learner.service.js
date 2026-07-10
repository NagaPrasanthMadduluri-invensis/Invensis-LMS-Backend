import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  schedules,
  trainingIds,
  trainingSessions,
  trainerAssignments,
  trainers,
  participants,
  enrolments,
  certificates,
  users,
  userProfiles,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { presignGet } from "../../lib/storage.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Whole days from now until a `YYYY-MM-DD` date (negative once past). null if absent.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.ceil((target - Date.now()) / MS_PER_DAY);
}

// days_left: days until the first upcoming session; 0 if ongoing, null if done/cancelled.
function computeDaysLeft(status, sessions) {
  if (status === "completed" || status === "cancelled") return null;
  if (status === "ongoing") return 0;
  const now = Date.now();
  const nextStart = sessions
    .map((s) => new Date(s.startTime).getTime())
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  if (!nextStart) return 0;
  return Math.ceil((nextStart - now) / MS_PER_DAY);
}

// Accepts either a trainingIds UUID or the human code (e.g. "TRN-2026-0001").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// All trainings the logged-in user is enrolled in — their "My Courses" list.
// Scoped by the user's own enrolments (capability-based: any authenticated user
// sees only their own), so no role gate is needed. Cancelled/transferred
// enrolments are excluded (transferred is superseded by the target enrolment).
export async function listMyTrainings(userId) {
  const rows = await db
    .select({
      id: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      deliveryMode: trainingIds.deliveryMode,
      status: trainingIds.status,
      meetingReleased: trainingIds.meetingReleased,
      enrolmentStatus: enrolments.status,
      enrolledAt: enrolments.enrolledAt,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      timezone: schedules.timezone,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(
      and(
        eq(participants.userId, userId),
        notInArray(enrolments.status, ["cancelled", "transferred"])
      )
    )
    .orderBy(desc(enrolments.enrolledAt));

  return {
    trainings: rows.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      delivery_mode: r.deliveryMode,
      status: r.status,
      start_date: r.startDate,
      end_date: r.endDate,
      timezone: r.timezone,
      enrolment_status: r.enrolmentStatus,
      meeting_released: r.meetingReleased,
      enrolled_at: r.enrolledAt,
    })),
  };
}

export async function getTrainingDetail(userId, trainingRef) {
  const [training] = await db
    .select()
    .from(trainingIds)
    .where(
      UUID_RE.test(trainingRef)
        ? eq(trainingIds.id, trainingRef)
        : eq(trainingIds.code, trainingRef)
    )
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);

  // Enrolment guard — the learner must have a confirmed enrolment.
  const enrolled = await db
    .select({ id: enrolments.id })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(
      and(
        eq(enrolments.trainingId, training.id),
        eq(participants.userId, userId),
        eq(enrolments.status, "confirmed")
      )
    )
    .limit(1);
  if (enrolled.length === 0) {
    throw new AppError("You are not enrolled in this training", 403);
  }

  // Currently-assigned trainer (if any)
  const [trainer] = await db
    .select({
      name: users.name,
      bio: trainers.bio,
      experience: trainers.experience,
    })
    .from(trainerAssignments)
    .innerJoin(trainers, eq(trainerAssignments.trainerId, trainers.id))
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(
      and(eq(trainerAssignments.trainingId, training.id), isNull(trainerAssignments.removedAt))
    )
    .limit(1);

  const sessions = await db
    .select({
      dayNumber: trainingSessions.dayNumber,
      plannedTopics: trainingSessions.plannedTopics,
      startTime: trainingSessions.startTime,
      endTime: trainingSessions.endTime,
      status: trainingSessions.status,
    })
    .from(trainingSessions)
    .where(eq(trainingSessions.trainingId, training.id))
    .orderBy(trainingSessions.dayNumber);

  // The linked schedule offering — source of dates, timezone, duration & capacity.
  let schedule = null;
  if (training.scheduleId) {
    [schedule] = await db
      .select({
        durationHours: schedules.durationHours,
        capacity: schedules.capacity,
        minSeats: schedules.minSeats,
        batchType: schedules.batchType,
        startDate: schedules.startDate,
        endDate: schedules.endDate,
        startTime: schedules.startTime,
        endTime: schedules.endTime,
        sessionDates: schedules.sessionDates,
        timezone: schedules.timezone,
        venue: schedules.venue,
      })
      .from(schedules)
      .where(eq(schedules.id, training.scheduleId))
      .limit(1);
  }

  const response = {
    training_id: training.code,
    title: training.title,
    delivery_mode: training.deliveryMode,
    bucket: training.bucket,
    status: training.status,
    // schedule offering fields (fall back to training-level values when no schedule is linked)
    duration_hours: schedule?.durationHours ?? null,
    capacity: schedule?.capacity ?? training.capacity,
    min_seats: schedule?.minSeats ?? training.minSeats,
    enrolled_count: training.enrolledCount,
    batch_type: schedule?.batchType ?? null,
    timezone: schedule?.timezone ?? null,
    start_date: schedule?.startDate ?? null,
    end_date: schedule?.endDate ?? null,
    start_time: schedule?.startTime ?? null,
    end_time: schedule?.endTime ?? null,
    session_dates: schedule?.sessionDates ?? null,
    venue: schedule?.venue ?? null,
    trainer: trainer ?? null,
    sessions: sessions.map((s) => ({
      day_number: s.dayNumber,
      planned_topics: s.plannedTopics,
      start_time: s.startTime,
      end_time: s.endTime,
      status: s.status,
    })),
    days_left: computeDaysLeft(training.status, sessions),
  };

  // Meeting link only when released.
  if (training.meetingReleased && training.meetingUrl) {
    response.meeting = { url: training.meetingUrl, platform: training.meetingPlatform };
  }

  return response;
}

/* ─────────────────────────────────────────────────────────
   Learner dashboard — a single snapshot for the learner landing page:
   profile summary, progress stats, a chronological learning journey, the
   learner's enrolments grouped by lifecycle (in-progress / upcoming /
   completed), certificates earned, and upcoming cohorts open to register
   for (a nudge to enrol). Capability-based — scoped to the caller's own
   enrolments, so no role gate is needed (mirrors listMyTrainings).
   ───────────────────────────────────────────────────────── */

// A learner is treated as having earned a certificate once their training is
// finished — either the enrolment or the training itself is marked completed.
function isFinished(r) {
  return r.enrolmentStatus === "completed" || r.trainingStatus === "completed";
}

// Compact course card for the dashboard widgets, enriched with progress.
function learnerCourseCard(r) {
  const total = r.totalSessions ?? 0;
  const done = r.completedSessions ?? 0;
  const finished = isFinished(r);
  const progressPct = finished ? 100 : total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    id: r.trainingId,
    code: r.code,
    title: r.title,
    delivery_mode: r.deliveryMode,
    bucket: r.bucket,
    status: r.trainingStatus,
    enrolment_status: r.enrolmentStatus,
    start_date: r.startDate,
    end_date: r.endDate,
    timezone: r.timezone,
    duration_hours: r.durationHours,
    enrolled_at: r.enrolledAt,
    total_sessions: total,
    completed_sessions: done,
    progress_pct: progressPct,
    days_until_start: r.trainingStatus === "ongoing" ? 0 : daysUntil(r.startDate),
    meeting_released: r.meetingReleased,
  };
}

export async function getDashboard(userId) {
  // ── Who is this learner (profile summary) ──
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new AppError("User not found", 404);

  const [profile] = await db
    .select({
      avatarKey: userProfiles.avatarKey,
      jobTitle: userProfiles.jobTitle,
      companyName: userProfiles.companyName,
      country: userProfiles.country,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const avatarUrl = profile?.avatarKey ? await presignGet(profile.avatarKey) : null;

  // ── All the learner's live enrolments, with per-training session progress ──
  const enrolRows = await db
    .select({
      enrolmentId: enrolments.id,
      enrolmentStatus: enrolments.status,
      enrolledAt: enrolments.enrolledAt,
      enrolmentUpdatedAt: enrolments.updatedAt,
      trainingId: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      deliveryMode: trainingIds.deliveryMode,
      bucket: trainingIds.bucket,
      trainingStatus: trainingIds.status,
      meetingReleased: trainingIds.meetingReleased,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      timezone: schedules.timezone,
      durationHours: schedules.durationHours,
      totalSessions: sql`(
        SELECT count(*)::int FROM training_sessions ts WHERE ts.training_id = ${trainingIds.id}
      )`,
      completedSessions: sql`(
        SELECT count(*)::int FROM training_sessions ts
        WHERE ts.training_id = ${trainingIds.id} AND ts.status = 'completed'
      )`,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(
      and(eq(participants.userId, userId), notInArray(enrolments.status, ["cancelled", "transferred"]))
    )
    .orderBy(desc(enrolments.enrolledAt));

  // ── Bucket enrolments by lifecycle ──
  const inProgress = [];
  const upcoming = [];
  const completed = [];
  const certificates = [];
  const journey = [];
  let learningHours = 0;

  for (const r of enrolRows) {
    const finished = isFinished(r);
    const card = learnerCourseCard(r);

    journey.push({
      type: "enrolled",
      date: r.enrolledAt,
      training_code: r.code,
      title: r.title,
    });

    if (finished) {
      completed.push(card);
      const completedAt = r.enrolmentUpdatedAt ?? r.endDate ?? null;
      if (r.durationHours) learningHours += r.durationHours;
      certificates.push({
        training_id: r.trainingId,
        training_code: r.code,
        title: r.title,
        delivery_mode: r.deliveryMode,
        duration_hours: r.durationHours,
        // Certificate content: the training's scheduled date range is the
        // "from/to" printed on the certificate; title = course name; the
        // participant's name comes from their account.
        start_date: r.startDate,
        end_date: r.endDate,
        completed_at: completedAt,
        // Completing the training makes the learner ELIGIBLE for the
        // certificate. Actually downloading it will later be gated on the
        // learner finishing the feedback + survey forms, and the certificate
        // PDF generation itself is not built yet — so 'downloadable' is a
        // forward-looking flag defaulted to false until that lands.
        eligible: true,
        downloadable: false,
      });
      journey.push({
        type: "completed",
        date: completedAt,
        training_code: r.code,
        title: r.title,
      });
    } else if (r.trainingStatus === "ongoing") {
      inProgress.push(card);
    } else {
      upcoming.push(card);
    }
  }

  // Journey oldest → newest so the frontend can render a timeline top-down.
  journey.sort((a, b) => new Date(a.date ?? 0) - new Date(b.date ?? 0));

  const totalEnrolments = enrolRows.length;
  const completionRate =
    totalEnrolments > 0 ? Math.round((completed.length / totalEnrolments) * 100) / 100 : 0;

  // ── Upcoming cohorts open to register for (marketing nudge) ──
  // Active offerings starting today or later; annotated with seats remaining so
  // the frontend can surface "filling fast" / "sold out" badges. Cohorts the
  // learner is already enrolled in are filtered out below.
  const enrolledTrainingIds = new Set(enrolRows.map((r) => r.trainingId));
  const cohortRows = await db
    .select({
      id: schedules.id,
      title: schedules.title,
      bucket: schedules.bucket,
      deliveryMode: schedules.deliveryMode,
      batchType: schedules.batchType,
      durationHours: schedules.durationHours,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      startTime: schedules.startTime,
      endTime: schedules.endTime,
      timezone: schedules.timezone,
      scheduleCapacity: schedules.capacity,
      trainingId: trainingIds.id,
      trainingCapacity: trainingIds.capacity,
      enrolledCount: trainingIds.enrolledCount,
    })
    .from(schedules)
    .leftJoin(
      trainingIds,
      and(eq(trainingIds.scheduleId, schedules.id), sql`${trainingIds.status} <> 'cancelled'`)
    )
    .where(and(eq(schedules.isActive, true), sql`${schedules.startDate} >= current_date`))
    .orderBy(asc(schedules.startDate))
    .limit(20);

  const upcomingCohorts = cohortRows
    .filter((c) => !(c.trainingId && enrolledTrainingIds.has(c.trainingId)))
    .slice(0, 8)
    .map((c) => {
      const capacity = c.trainingCapacity ?? c.scheduleCapacity ?? 0;
      const enrolled = c.enrolledCount ?? 0;
      const seatsLeft = Math.max(capacity - enrolled, 0);
      return {
        schedule_id: c.id,
        title: c.title,
        bucket: c.bucket,
        delivery_mode: c.deliveryMode,
        batch_type: c.batchType,
        duration_hours: c.durationHours,
        start_date: c.startDate,
        end_date: c.endDate,
        start_time: c.startTime,
        end_time: c.endTime,
        timezone: c.timezone,
        capacity,
        seats_left: seatsLeft,
        starts_in_days: daysUntil(c.startDate),
        filling_fast: capacity > 0 && seatsLeft > 0 && seatsLeft / capacity <= 0.25,
        is_full: capacity > 0 && seatsLeft === 0,
      };
    });

  return {
    generated_at: new Date().toISOString(),
    learner: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar_url: avatarUrl,
      job_title: profile?.jobTitle ?? null,
      company_name: profile?.companyName ?? null,
      country: profile?.country ?? null,
      member_since: user.createdAt,
    },
    stats: {
      total_enrolments: totalEnrolments,
      in_progress: inProgress.length,
      upcoming: upcoming.length,
      completed: completed.length,
      certificates_earned: certificates.length,
      learning_hours: learningHours,
      completion_rate: completionRate, // completed / total, 0–1
    },
    my_courses: {
      in_progress: inProgress,
      upcoming,
      completed,
    },
    certificates,
    journey,
    upcoming_cohorts: upcomingCohorts,
  };
}

/* ─────────────────────────────────────────────────────────
   Certificates (learner training certificates)

   Flow: an enrolment marked 'completed' by an admin makes the learner
   ELIGIBLE. Downloading is gated on the learner submitting the post-training
   feedback survey — that submission "issues" the certificate (creates the
   certificates row with a stable code). The printable certificate shows the
   participant name, course title, scheduled date range, the schedule event
   code (Activity ID) and the generated Certificate ID.
   ───────────────────────────────────────────────────────── */

// Stable, human-looking certificate code derived from the enrolment id, e.g.
// "INVLJA4184" — deterministic so it never changes for a given enrolment.
function generateCertificateCode(enrolmentId) {
  const n = parseInt(createHash("sha1").update(enrolmentId).digest("hex").slice(0, 12), 16);
  const L = "ABCDEFGHIJKLMNPQRSTUVWXYZ"; // drop 'O' to avoid 0/O confusion
  const l1 = L[n % L.length];
  const l2 = L[Math.floor(n / L.length) % L.length];
  const digits = String(n % 10000).padStart(4, "0");
  return `INVL${l1}${l2}${digits}`;
}

// The Activity ID printed on the certificate is the linked schedule's event
// code (e.g. "INL000099"); manually-created trainings have no schedule, so we
// fall back to the training code.
function activityCodeFor(eventCode, trainingCode) {
  return eventCode ?? trainingCode;
}

// Find the caller's eligible (completed) enrolment for a training ref (UUID or
// code), joined with the training, its schedule and any issued certificate.
// Returns null when the caller has no such eligible enrolment.
async function findEligibleEnrolment(userId, trainingRef) {
  const cond = UUID_RE.test(trainingRef)
    ? eq(trainingIds.id, trainingRef)
    : eq(trainingIds.code, trainingRef);
  const [row] = await db
    .select({
      enrolmentId: enrolments.id,
      enrolmentUpdatedAt: enrolments.updatedAt,
      trainingId: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      deliveryMode: trainingIds.deliveryMode,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      eventCode: schedules.externalScheduleCode,
      participantName: participants.name,
      certCode: certificates.certificateCode,
      certActivity: certificates.activityCode,
      issuedAt: certificates.issuedAt,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
    .where(
      and(
        eq(participants.userId, userId),
        cond,
        sql`(${enrolments.status} = 'completed' OR ${trainingIds.status} = 'completed')`
      )
    )
    .limit(1);
  return row ?? null;
}

// Shape the render/list payload for one certificate row.
function certificateDto(r) {
  const issued = !!r.certCode;
  return {
    training_id: r.trainingId,
    training_code: r.code,
    title: r.title, // course name printed on the certificate
    delivery_mode: r.deliveryMode,
    start_date: r.startDate,
    end_date: r.endDate,
    participant_name: r.participantName,
    activity_id: r.certActivity ?? activityCodeFor(r.eventCode, r.code),
    certificate_id: r.certCode ?? null,
    issued, // survey submitted → certificate unlocked/downloadable
    issued_at: r.issuedAt ?? null,
    completed_at: r.enrolmentUpdatedAt ?? r.endDate ?? null,
  };
}

// List every certificate the caller is eligible for (their completed
// enrolments), each annotated with whether it's been issued (survey done).
export async function listCertificates(userId) {
  const rows = await db
    .select({
      enrolmentId: enrolments.id,
      enrolmentUpdatedAt: enrolments.updatedAt,
      trainingId: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      deliveryMode: trainingIds.deliveryMode,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      eventCode: schedules.externalScheduleCode,
      participantName: participants.name,
      certCode: certificates.certificateCode,
      certActivity: certificates.activityCode,
      issuedAt: certificates.issuedAt,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
    .where(
      and(
        eq(participants.userId, userId),
        sql`(${enrolments.status} = 'completed' OR ${trainingIds.status} = 'completed')`
      )
    )
    .orderBy(desc(enrolments.enrolledAt));

  return { certificates: rows.map(certificateDto) };
}

// Full data for the printable certificate. 403 until the survey is submitted
// (the certificate must be issued to be viewed/downloaded).
export async function getCertificate(userId, trainingRef) {
  const row = await findEligibleEnrolment(userId, trainingRef);
  if (!row) throw new AppError("You are not eligible for this certificate", 403);
  if (!row.certCode) {
    throw new AppError("Complete the feedback survey to unlock your certificate", 403);
  }
  return { certificate: certificateDto(row) };
}

// Submit the post-training feedback survey and issue the certificate. Requires
// a completed enrolment owned by the caller. Idempotent — if already issued,
// the existing certificate is returned unchanged.
export async function issueCertificateWithSurvey(userId, trainingRef, responses) {
  const row = await findEligibleEnrolment(userId, trainingRef);
  if (!row) throw new AppError("You are not eligible for this certificate", 403);

  // Already issued → return as-is (don't overwrite the recorded survey).
  if (row.certCode) return { certificate: certificateDto(row) };

  const activityCode = activityCodeFor(row.eventCode, row.code);
  const certificateCode = generateCertificateCode(row.enrolmentId);

  const [created] = await db
    .insert(certificates)
    .values({
      enrolmentId: row.enrolmentId,
      certificateCode,
      activityCode,
      surveyResponses: responses,
    })
    .onConflictDoNothing({ target: certificates.enrolmentId })
    .returning();

  // Race: another request issued it first — read it back.
  const issued =
    created ??
    (await db
      .select({ certificateCode: certificates.certificateCode, activityCode: certificates.activityCode, issuedAt: certificates.issuedAt })
      .from(certificates)
      .where(eq(certificates.enrolmentId, row.enrolmentId))
      .limit(1))[0];

  return {
    certificate: certificateDto({
      ...row,
      certCode: issued.certificateCode,
      certActivity: issued.activityCode,
      issuedAt: issued.issuedAt,
    }),
  };
}
