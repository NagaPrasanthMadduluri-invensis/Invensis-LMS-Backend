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
        completed_at: completedAt,
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
