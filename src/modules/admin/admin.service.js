import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  trainingIds,
  trainingSessions,
  trainers,
  trainerAssignments,
  enrolments,
  schedules,
  participants,
  certificates,
  users,
  userProfiles,
  surveys,
  surveyResponses,
  attendanceRecords,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { hashPassword } from "../../lib/password.js";
import { provisionAccountSetup } from "../../lib/account-setup.js";
import { issueCertificate } from "../../lib/certificates.js";
import { enqueueMeetingLinkRelease } from "../../lib/queue.js";

// Accepts either a trainingIds UUID or the human code (e.g. "TRN-2026-0001").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTraining(runner, ref) {
  const [training] = await runner
    .select()
    .from(trainingIds)
    .where(UUID_RE.test(ref) ? eq(trainingIds.id, ref) : eq(trainingIds.code, ref))
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);
  return training;
}

function publicTraining(t) {
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    status: t.status,
    enrolled_count: t.enrolledCount,
    min_seats: t.minSeats,
    min_seats_override: t.minSeatsOverride,
    meeting_url: t.meetingUrl,
    meeting_platform: t.meetingPlatform,
    meeting_released: t.meetingReleased,
    meeting_triggered_at: t.meetingTriggeredAt,
  };
}

export async function updateTraining(adminId, trainingRef, body, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);
    const trainingId = training.id;

    /* ── Assign trainer ── */
    if (body.trainer_id) {
      const [trainer] = await tx
        .select()
        .from(trainers)
        .where(eq(trainers.id, body.trainer_id))
        .limit(1);
      if (!trainer || !trainer.isActive) {
        throw new AppError("Trainer not found or inactive", 400);
      }

      // Close out the existing active assignment (preserve history).
      const [existing] = await tx
        .select()
        .from(trainerAssignments)
        .where(
          and(eq(trainerAssignments.trainingId, trainingId), isNull(trainerAssignments.removedAt))
        )
        .limit(1);
      if (existing) {
        if (existing.trainerId === body.trainer_id) {
          throw new AppError("Trainer is already assigned to this training", 409);
        }
        await tx
          .update(trainerAssignments)
          .set({ removedAt: new Date() })
          .where(eq(trainerAssignments.id, existing.id));
      }

      await tx.insert(trainerAssignments).values({
        trainingId,
        trainerId: body.trainer_id,
        assignedBy: adminId,
      });

      await writeAudit(tx, {
        entityType: "training_id",
        entityId: trainingId,
        action: "trainer_assigned",
        actorId: adminId,
        before: { trainer_id: existing?.trainerId ?? null },
        after: { trainer_id: body.trainer_id },
        ipAddress: ip,
      });
    }

    /* ── Set meeting link ── */
    const hasMeeting =
      body.meeting_url !== undefined ||
      body.meeting_platform !== undefined ||
      body.meeting_released !== undefined;

    if (hasMeeting) {
      const releasing = body.meeting_released === true && !training.meetingReleased;

      // Override may be requested in this same request, or already stored.
      const overrideEnabled =
        body.min_seats_override === true || training.minSeatsOverride;

      // Min-seat gate on release (unless overridden).
      if (body.meeting_released === true && !overrideEnabled) {
        const [{ count }] = await tx
          .select({ count: sql`count(*)::int` })
          .from(enrolments)
          .where(and(eq(enrolments.trainingId, trainingId), eq(enrolments.status, "confirmed")));
        if (count < training.minSeats) {
          throw new AppError(
            `Minimum seats not met (${count}/${training.minSeats}); cannot release meeting link`,
            422
          );
        }
      }

      const before = {
        meeting_url: training.meetingUrl,
        meeting_platform: training.meetingPlatform,
        meeting_released: training.meetingReleased,
      };
      const after = {
        meeting_url: body.meeting_url ?? training.meetingUrl,
        meeting_platform: body.meeting_platform ?? training.meetingPlatform,
        meeting_released: body.meeting_released ?? training.meetingReleased,
      };

      await tx
        .update(trainingIds)
        .set({
          meetingUrl: after.meeting_url,
          meetingPlatform: after.meeting_platform,
          meetingReleased: after.meeting_released,
          minSeatsOverride: overrideEnabled,
          meetingTriggeredBy: adminId,
          meetingTriggeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(trainingIds.id, trainingId));

      await writeAudit(tx, {
        entityType: "training_id",
        entityId: trainingId,
        action: releasing ? "meeting_link_released" : "meeting_link_set",
        actorId: adminId,
        before,
        after,
        ipAddress: ip,
      });

      // Real impl would enqueue after commit; the stub just logs.
      if (releasing) await enqueueMeetingLinkRelease(trainingId);
    }

    const [updated] = await tx
      .select()
      .from(trainingIds)
      .where(eq(trainingIds.id, trainingId))
      .limit(1);
    return publicTraining(updated);
  });
}

/* ─────────────────────────────────────────────────────────
   Training status lifecycle: Due-for-update flag, set status
   (Completed / Suspended / re-Activate), and postpone+reschedule.
   ───────────────────────────────────────────────────────── */

// Terminal states an admin can't transition out of.
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
// Statuses that are still "live" for the due-for-update prompt.
const OPEN_STATUSES = new Set(["pending", "active", "ongoing", "postponed"]);

// "Due for Update" is computed on read — no background job. A training whose end
// date has passed while it's still open (not completed/cancelled/suspended)
// prompts the admin to mark it Completed / Postponed / Suspended.
export function computeDueForUpdate(status, endDate) {
  if (!endDate || !OPEN_STATUSES.has(status)) return false;
  const end = new Date(`${String(endDate).slice(0, 10)}T23:59:59Z`);
  return end.getTime() < Date.now();
}

/**
 * Set a training's status to `completed`, `suspended`, or `active` (reactivate a
 * suspended/postponed one). Rescheduling is a separate action (see below).
 * `completed`/`cancelled` are terminal — can't be changed once set.
 */
export async function setTrainingStatus(adminId, trainingRef, { status, note }, ip) {
  const ALLOWED = new Set(["completed", "suspended", "active"]);
  if (!ALLOWED.has(status)) {
    throw new AppError("status must be one of: completed, suspended, active", 422);
  }
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);
    if (TERMINAL_STATUSES.has(training.status)) {
      throw new AppError(`This training is ${training.status} and can no longer change status`, 409);
    }
    if (training.status === status) {
      throw new AppError(`Training is already ${status}`, 409);
    }

    const now = new Date();
    await tx
      .update(trainingIds)
      .set({
        status,
        statusNote: note ?? null,
        statusChangedBy: adminId,
        statusChangedAt: now,
        // Reactivating clears the postponed marker.
        ...(status === "active" ? { postponedAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(trainingIds.id, training.id));

    await writeAudit(tx, {
      entityType: "training_id",
      entityId: training.id,
      action: `status_${status}`,
      actorId: adminId,
      before: { status: training.status },
      after: { status, note: note ?? null },
      reason: note ?? null,
      ipAddress: ip,
    });

    const [updated] = await tx.select().from(trainingIds).where(eq(trainingIds.id, training.id)).limit(1);
    return publicTraining(updated);
  });
}

// Generate N consecutive ISO dates from a start date (YYYY-MM-DD).
function consecutiveDates(startDate, count) {
  const out = [];
  const base = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Minutes past midnight for a "HH:MM" / "HH:MM:SS" wall time.
function timeToMinutes(t) {
  const [h, m] = String(t).split(":");
  return Number(h) * 60 + Number(m);
}

// "09:00" → "09:00:00". The API accepts HH:MM, Postgres `time` stores
// HH:MM:SS; normalising up front keeps the row, the response and the audit
// entry all quoting the same string.
function normalizeTime(t) {
  const [h = "00", m = "00", sec = "00"] = String(t).split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${sec.padStart(2, "0")}`;
}

/**
 * Postpone + reschedule: move an active training to new days/times/timezone.
 * The training's single `schedules` row and its `training_sessions` are updated
 * in place, so every portal (admin/trainer/learner/sponsor) reflects the new
 * date automatically. Status is set to `postponed` (still an active training
 * under the hood — just moved). Planned topics on each day are preserved.
 *
 * body: { session_dates?, start_date?, start_time?, end_time?, timezone?, note? }
 *
 * `session_dates` is the real input: the exact days the training runs on, which
 * need not be consecutive — a two-month window may hold only ten teaching days.
 * They are sorted and de-duplicated here, and the schedule's `start_date` /
 * `end_date` become the first and last of them.
 *
 * `start_date` alone is the legacy shorthand: N consecutive days from it, where
 * N = the current number of sessions (falling back to the current sessionDates).
 *
 * `hours_per_day` and `duration_hours` are recomputed from the daily window and
 * the day count, so the stored totals never drift from the new schedule.
 */
export async function rescheduleTraining(adminId, trainingRef, body, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);
    if (TERMINAL_STATUSES.has(training.status)) {
      throw new AppError(`This training is ${training.status} and can't be rescheduled`, 409);
    }
    if (!training.scheduleId) {
      throw new AppError("This training has no schedule to reschedule", 422);
    }

    const [schedule] = await tx
      .select()
      .from(schedules)
      .where(eq(schedules.id, training.scheduleId))
      .limit(1);
    if (!schedule) throw new AppError("Schedule not found", 404);

    // Existing sessions (ordered) — we preserve planned topics by day number.
    const existing = await tx
      .select()
      .from(trainingSessions)
      .where(eq(trainingSessions.trainingId, training.id))
      .orderBy(trainingSessions.dayNumber);

    const currentCount = existing.length || (Array.isArray(schedule.sessionDates) ? schedule.sessionDates.length : 1);
    const startTime = normalizeTime(body.start_time || schedule.startTime);
    const endTime = normalizeTime(body.end_time || schedule.endTime);
    const timezone = body.timezone ?? schedule.timezone;

    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      throw new AppError("The daily end time must be after the start time", 422);
    }

    // The exact training days. Sorted and de-duplicated so the first is always
    // the new start and the last the new end, whatever order they were picked.
    const sessionDates =
      Array.isArray(body.session_dates) && body.session_dates.length
        ? [...new Set(body.session_dates.map((d) => String(d).slice(0, 10)))].sort()
        : consecutiveDates(String(body.start_date).slice(0, 10), currentCount);

    const startDate = sessionDates[0];
    const endDate = sessionDates[sessionDates.length - 1];

    // Totals follow from the window and the day count — never left to drift.
    // Both columns are integers, so the total is rounded from the exact
    // minutes rather than from the already-rounded per-day figure (a 8h30m
    // window over 10 days is 85 hours, not 90).
    const minutesPerDay = timeToMinutes(endTime) - timeToMinutes(startTime);
    const hoursPerDay = Math.round(minutesPerDay / 60);
    const durationHours = Math.round((minutesPerDay * sessionDates.length) / 60);

    const before = {
      start_date: schedule.startDate,
      end_date: schedule.endDate,
      start_time: schedule.startTime,
      end_time: schedule.endTime,
      timezone: schedule.timezone,
      session_dates: schedule.sessionDates,
      hours_per_day: schedule.hoursPerDay,
      duration_hours: schedule.durationHours,
    };

    // 1. Update the schedule row (the single source of dates for all portals).
    await tx
      .update(schedules)
      .set({
        startDate,
        endDate,
        startTime,
        endTime,
        timezone,
        sessionDates,
        hoursPerDay,
        durationHours,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, schedule.id));

    // 2. Regenerate day-wise sessions. Update overlapping days in place (keeping
    //    planned_topics), insert new days, and drop surplus days that have no
    //    attendance recorded (never orphan attendance rows).
    for (let i = 0; i < sessionDates.length; i++) {
      const d = sessionDates[i];
      const start = new Date(`${d}T${startTime}Z`);
      const end = new Date(`${d}T${endTime}Z`);
      const row = existing[i];
      if (row) {
        await tx
          .update(trainingSessions)
          .set({ startTime: start, endTime: end, status: "scheduled" })
          .where(eq(trainingSessions.id, row.id));
      } else {
        await tx.insert(trainingSessions).values({
          trainingId: training.id,
          dayNumber: i + 1,
          startTime: start,
          endTime: end,
        });
      }
    }
    // Surplus sessions (schedule now shorter): delete only if no attendance.
    //
    // Attendance isn't deployed in every environment. Probe for the table once
    // rather than letting a missing-relation error abort the whole transaction
    // (Postgres poisons a transaction on the first failed statement, so a
    // try/catch here would not save it). No table means no attendance rows to
    // protect, so the surplus days are simply removed.
    if (sessionDates.length < existing.length) {
      const probe = await tx.execute(
        sql`select to_regclass('public.attendance_records') is not null as present`
      );
      const attendanceTracked = !!(probe.rows?.[0]?.present ?? probe[0]?.present);

      for (let i = sessionDates.length; i < existing.length; i++) {
        const row = existing[i];
        let attended = false;
        if (attendanceTracked) {
          const [att] = await tx
            .select({ id: attendanceRecords.id })
            .from(attendanceRecords)
            .where(eq(attendanceRecords.sessionId, row.id))
            .limit(1);
          attended = !!att;
        }
        if (!attended) {
          await tx.delete(trainingSessions).where(eq(trainingSessions.id, row.id));
        }
      }
    }

    // 3. Flag the training as postponed (still active under the hood).
    const now = new Date();
    await tx
      .update(trainingIds)
      .set({
        status: "postponed",
        statusNote: body.note ?? null,
        statusChangedBy: adminId,
        statusChangedAt: now,
        postponedAt: now,
        updatedAt: now,
      })
      .where(eq(trainingIds.id, training.id));

    await writeAudit(tx, {
      entityType: "training_id",
      entityId: training.id,
      action: "rescheduled",
      actorId: adminId,
      before,
      after: {
        start_date: startDate,
        end_date: endDate,
        start_time: startTime,
        end_time: endTime,
        timezone,
        session_dates: sessionDates,
        hours_per_day: hoursPerDay,
        duration_hours: durationHours,
      },
      reason: body.note ?? null,
      ipAddress: ip,
    });

    const [updated] = await tx.select().from(trainingIds).where(eq(trainingIds.id, training.id)).limit(1);
    return {
      ...publicTraining(updated),
      start_date: startDate,
      end_date: endDate,
      start_time: startTime,
      end_time: endTime,
      timezone,
      session_dates: sessionDates,
      hours_per_day: hoursPerDay,
      duration_hours: durationHours,
    };
  });
}

/* ── List all trainings (Training IDs) for the admin courses view ── */
export async function listTrainings() {
  const rows = await db
    .select({
      id: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      status: trainingIds.status,
      deliveryMode: trainingIds.deliveryMode,
      bucket: trainingIds.bucket,
      capacity: trainingIds.capacity,
      enrolledCount: trainingIds.enrolledCount,
      minSeats: trainingIds.minSeats,
      createdAt: trainingIds.createdAt,
      meetingUrl: trainingIds.meetingUrl,
      meetingPlatform: trainingIds.meetingPlatform,
      meetingReleased: trainingIds.meetingReleased,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      durationHours: schedules.durationHours,
      timezone: schedules.timezone,
      trainerName: users.name,
    })
    .from(trainingIds)
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(
      trainerAssignments,
      and(
        eq(trainerAssignments.trainingId, trainingIds.id),
        isNull(trainerAssignments.removedAt)
      )
    )
    .leftJoin(trainers, eq(trainerAssignments.trainerId, trainers.id))
    .leftJoin(users, eq(trainers.userId, users.id))
    .orderBy(asc(schedules.startDate), desc(trainingIds.createdAt)); // by training date, ascending (nulls last)

  return {
    trainings: rows.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      due_for_update: computeDueForUpdate(r.status, r.endDate),
      delivery_mode: r.deliveryMode,
      bucket: r.bucket,
      capacity: r.capacity,
      enrolled_count: r.enrolledCount,
      min_seats: r.minSeats,
      start_date: r.startDate,
      end_date: r.endDate,
      duration_hours: r.durationHours,
      timezone: r.timezone,
      meeting_url: r.meetingUrl,
      meeting_platform: r.meetingPlatform,
      meeting_released: r.meetingReleased,
      trainer_assigned: r.trainerName != null,
      trainer_name: r.trainerName ?? null,
    })),
  };
}

/* ── Full training detail for admin: schedule + trainer + participants ── */
export async function getTrainingDetail(trainingRef) {
  const training = await resolveTraining(db, trainingRef);

  let schedule = null;
  if (training.scheduleId) {
    [schedule] = await db
      .select({
        durationHours: schedules.durationHours,
        hoursPerDay: schedules.hoursPerDay,
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

  const [trainer] = await db
    .select({
      id: trainers.id,
      name: users.name,
      email: users.email,
      bio: trainers.bio,
      experience: trainers.experience,
      assignedAt: trainerAssignments.assignedAt,
    })
    .from(trainerAssignments)
    .innerJoin(trainers, eq(trainerAssignments.trainerId, trainers.id))
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(
      and(eq(trainerAssignments.trainingId, training.id), isNull(trainerAssignments.removedAt))
    )
    .limit(1);

  const enrolled = await db
    .select({
      enrolmentId: enrolments.id,
      status: enrolments.status,
      enrolledAt: enrolments.enrolledAt,
      orderId: enrolments.orderId,
      participantId: participants.id,
      name: participants.name,
      email: participants.email,
      phone: participants.phone,
      jobTitle: participants.jobTitle,
      city: participants.city,
      country: participants.country,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(eq(enrolments.trainingId, training.id))
    .orderBy(desc(enrolments.enrolledAt));

  const sessions = await db
    .select({
      id: trainingSessions.id,
      dayNumber: trainingSessions.dayNumber,
      plannedTopics: trainingSessions.plannedTopics,
      startTime: trainingSessions.startTime,
      endTime: trainingSessions.endTime,
      status: trainingSessions.status,
    })
    .from(trainingSessions)
    .where(eq(trainingSessions.trainingId, training.id))
    .orderBy(trainingSessions.dayNumber);

  return {
    id: training.id,
    training_id: training.code,
    title: training.title,
    delivery_mode: training.deliveryMode,
    bucket: training.bucket,
    status: training.status,
    due_for_update: computeDueForUpdate(training.status, schedule?.endDate),
    status_note: training.statusNote ?? null,
    status_changed_at: training.statusChangedAt ?? null,
    postponed_at: training.postponedAt ?? null,
    course_slug: training.courseSlug ?? null,
    course_type: training.courseType ?? null,
    certification_included: training.certificationIncluded ?? false,
    capacity: schedule?.capacity ?? training.capacity,
    min_seats: schedule?.minSeats ?? training.minSeats,
    enrolled_count: training.enrolledCount,
    duration_hours: schedule?.durationHours ?? null,
    hours_per_day: schedule?.hoursPerDay ?? null,
    batch_type: schedule?.batchType ?? null,
    timezone: schedule?.timezone ?? null,
    start_date: schedule?.startDate ?? null,
    end_date: schedule?.endDate ?? null,
    start_time: schedule?.startTime ?? null,
    end_time: schedule?.endTime ?? null,
    session_dates: schedule?.sessionDates ?? null,
    venue: schedule?.venue ?? null,
    meeting_url: training.meetingUrl,
    meeting_platform: training.meetingPlatform,
    meeting_released: training.meetingReleased,
    meeting_triggered_at: training.meetingTriggeredAt,
    trainer: trainer
      ? {
          id: trainer.id,
          name: trainer.name,
          email: trainer.email,
          bio: trainer.bio,
          experience: trainer.experience,
          assigned_at: trainer.assignedAt,
        }
      : null,
    participants: enrolled.map((e) => ({
      enrolment_id: e.enrolmentId,
      participant_id: e.participantId,
      name: e.name,
      email: e.email,
      phone: e.phone,
      job_title: e.jobTitle,
      city: e.city,
      country: e.country,
      location: [e.city, e.country].filter(Boolean).join(", ") || null,
      status: e.status,
      enrolled_at: e.enrolledAt,
      added_manually: e.orderId == null,
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      day_number: s.dayNumber,
      planned_topics: s.plannedTopics,
      start_time: s.startTime,
      end_time: s.endTime,
      status: s.status,
    })),
  };
}

/* ── Trainers list. By default only active ones (for the assignment picker);
   pass includeInactive for the admin management table so deactivated trainers
   stay editable/reactivatable. ── */
export async function listTrainers({ includeInactive = false } = {}) {
  const rows = await db
    .select({
      id: trainers.id,
      name: users.name,
      email: users.email,
      bio: trainers.bio,
      experience: trainers.experience,
      rate: trainers.rate,
      certificates: trainers.certificates,
      specializations: trainers.specializations,
      city: trainers.city,
      country: trainers.country,
      isRemote: trainers.isRemote,
      isActive: trainers.isActive,
    })
    .from(trainers)
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(includeInactive ? undefined : eq(trainers.isActive, true))
    .orderBy(users.name);

  return {
    trainers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      bio: r.bio,
      experience: r.experience,
      rate: r.rate,
      certificates: r.certificates ?? [],
      specializations: r.specializations ?? [],
      city: r.city ?? null,
      country: r.country ?? null,
      is_remote: r.isRemote ?? false,
      location: formatTrainerLocation({ city: r.city, country: r.country, isRemote: r.isRemote }),
      is_active: r.isActive,
    })),
  };
}

/* ── Manually add a participant + confirmed enrolment to a training ── */
export async function addParticipant(adminId, trainingRef, body, ip) {
  let provision = null; // set when a brand-new account is created
  const result = await db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);

    if (training.capacity != null && training.enrolledCount >= training.capacity) {
      throw new AppError("Training is at full capacity", 422);
    }

    const email = body.email.trim().toLowerCase();
    const name = body.name.trim();

    // Find or create the learner's user account.
    let [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user) {
      // No password — a setup email is sent after commit.
      [user] = await tx
        .insert(users)
        .values({ email, name, role: "learner" })
        .returning({ id: users.id });
      provision = { id: user.id, name, email };
    }

    // Upsert the participant, linked to that user account.
    let [participant] = await tx
      .select()
      .from(participants)
      .where(eq(participants.email, email))
      .limit(1);
    if (!participant) {
      [participant] = await tx
        .insert(participants)
        .values({
          userId: user.id,
          name,
          email,
          phone: body.phone ?? null,
          jobTitle: body.job_title ?? null,
        })
        .returning();
    } else if (!participant.userId) {
      await tx.update(participants).set({ userId: user.id }).where(eq(participants.id, participant.id));
    }

    // Insert the enrolment; the partial unique index blocks a duplicate active one.
    const inserted = await tx
      .insert(enrolments)
      .values({ trainingId: training.id, participantId: participant.id, status: "confirmed" })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      throw new AppError("Participant is already enrolled in this training", 409);
    }

    // Refresh enrolled_count from live confirmed rows.
    const cnt = await tx.execute(
      sql`SELECT count(*)::int AS n FROM enrolments WHERE training_id = ${training.id} AND status = 'confirmed'`
    );
    const enrolledCount = cnt.rows?.[0]?.n ?? 0;
    await tx
      .update(trainingIds)
      .set({ enrolledCount, updatedAt: new Date() })
      .where(eq(trainingIds.id, training.id));

    await writeAudit(tx, {
      entityType: "enrolment",
      entityId: inserted[0].id,
      action: "participant_added_manually",
      actorId: adminId,
      after: { email, name, training_code: training.code },
      ipAddress: ip,
    });

    return {
      participant: {
        enrolment_id: inserted[0].id,
        participant_id: participant.id,
        name,
        email,
        phone: body.phone ?? null,
        job_title: body.job_title ?? null,
        status: "confirmed",
        enrolled_at: inserted[0].enrolledAt,
        added_manually: true,
      },
      enrolled_count: enrolledCount,
    };
  });

  if (provision) await provisionAccountSetup(provision, "setup");
  return result;
}

/* ─────────────────────────────────────────────────────────
   Trainer management
   ───────────────────────────────────────────────────────── */

// Human-readable location: "City, Country", with a "Remote" marker for online
// trainers. Returns null when nothing is set.
function formatTrainerLocation({ city, country, isRemote }) {
  const place = [city, country].filter(Boolean).join(", ");
  if (isRemote) return place ? `${place} · Remote` : "Remote";
  return place || null;
}

function publicTrainer(t, u) {
  return {
    id: t.id,
    user_id: t.userId,
    name: u.name,
    email: u.email,
    bio: t.bio,
    experience: t.experience,
    rate: t.rate,
    certificates: t.certificates,
    specializations: t.specializations ?? [],
    city: t.city ?? null,
    country: t.country ?? null,
    is_remote: t.isRemote ?? false,
    location: formatTrainerLocation({ city: t.city, country: t.country, isRemote: t.isRemote }),
    is_active: t.isActive,
  };
}

// Onboard a trainer: ensure a user account (role trainer) + a trainers profile.
export async function onboardTrainer(adminId, body, ip) {
  let provision = null; // set when a new account is created without a password
  const result = await db.transaction(async (tx) => {
    const { email, name } = body;

    let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      // If a password was supplied, use it. Otherwise create with no password
      // and email a setup link after commit. (If the user already exists we
      // never touch their password — only add the trainer profile.)
      const passwordHash = body.password ? await hashPassword(body.password) : null;
      [user] = await tx
        .insert(users)
        .values({ email, name, role: "trainer", passwordHash })
        .returning();
      if (!body.password) provision = { id: user.id, name, email };
    }

    const [existing] = await tx
      .select({ id: trainers.id })
      .from(trainers)
      .where(eq(trainers.userId, user.id))
      .limit(1);
    if (existing) throw new AppError("This user is already a trainer", 409);

    const [trainer] = await tx
      .insert(trainers)
      .values({
        userId: user.id,
        bio: body.bio ?? null,
        experience: body.experience ?? null,
        rate: body.rate != null ? String(body.rate) : null,
        certificates: body.certificates ?? [],
        specializations: body.specializations ?? [],
        city: body.city ?? null,
        country: body.country ?? null,
        isRemote: body.is_remote ?? false,
      })
      .returning();

    await writeAudit(tx, {
      entityType: "trainer",
      entityId: trainer.id,
      action: "trainer_onboarded",
      actorId: adminId,
      after: { email, name },
      ipAddress: ip,
    });

    return publicTrainer(trainer, user);
  });

  if (provision) await provisionAccountSetup(provision, "setup");
  return result;
}

// Bucket a training into a display category from its lifecycle status.
function trainingCategory(status) {
  if (status === "completed") return "completed";
  if (status === "ongoing") return "ongoing";
  if (status === "cancelled") return "cancelled";
  return "upcoming"; // pending | active — scheduled but not started
}

// Round a numeric-ish value to 2dp, preserving null.
function round2(v) {
  return v == null ? null : Number(Number(v).toFixed(2));
}

export async function getTrainerDetail(trainerId) {
  const [row] = await db
    .select({ t: trainers, u: users })
    .from(trainers)
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(eq(trainers.id, trainerId))
    .limit(1);
  if (!row) throw new AppError("Trainer not found", 404);

  // Every training the trainer has been assigned to, enriched with schedule
  // dates + seat counts so the admin can see the full picture per training.
  const history = await db
    .select({
      trainingId: trainerAssignments.trainingId,
      code: trainingIds.code,
      title: trainingIds.title,
      bucket: trainingIds.bucket,
      deliveryMode: trainingIds.deliveryMode,
      status: trainingIds.status,
      capacity: trainingIds.capacity,
      enrolledCount: trainingIds.enrolledCount,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      assignedAt: trainerAssignments.assignedAt,
      removedAt: trainerAssignments.removedAt,
    })
    .from(trainerAssignments)
    .innerJoin(trainingIds, eq(trainerAssignments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(eq(trainerAssignments.trainerId, trainerId))
    .orderBy(desc(trainerAssignments.assignedAt));

  // Feedback ratings come from the post-training survey learners submit — stored
  // as jsonb on the certificate ({ overall_rating, trainer_rating, content_rating,
  // would_recommend }). Aggregate them per-training and overall for this trainer.
  const ratingSql = (extra) => sql`
    SELECT
      ${extra}
      count(*)::int AS reviews,
      avg((c.survey_responses->>'trainer_rating')::numeric) AS trainer_rating,
      avg((c.survey_responses->>'overall_rating')::numeric) AS overall_rating,
      avg((c.survey_responses->>'content_rating')::numeric) AS content_rating,
      count(*) FILTER (WHERE (c.survey_responses->>'would_recommend')::boolean) AS recommend
    FROM certificates c
    JOIN enrolments e ON e.id = c.enrolment_id
    WHERE e.training_id IN (
      SELECT training_id FROM trainer_assignments WHERE trainer_id = ${trainerId}
    )
  `;

  const perTraining = await db.execute(sql`${ratingSql(sql`e.training_id AS training_id,`)} GROUP BY e.training_id`);
  const ratingByTraining = new Map(perTraining.rows.map((r) => [r.training_id, r]));

  const overallRows = await db.execute(ratingSql(sql``));
  const overall = overallRows.rows[0] || {};
  const reviews = Number(overall.reviews || 0);

  const assignments = history.map((a) => {
    const r = ratingByTraining.get(a.trainingId);
    const rReviews = r ? Number(r.reviews) : 0;
    return {
      training_id: a.trainingId,
      code: a.code,
      title: a.title,
      bucket: a.bucket,
      delivery_mode: a.deliveryMode,
      status: a.status,
      category: trainingCategory(a.status),
      capacity: a.capacity,
      enrolled_count: a.enrolledCount,
      start_date: a.startDate,
      end_date: a.endDate,
      assigned_at: a.assignedAt,
      removed_at: a.removedAt,
      active: a.removedAt == null,
      reviews: rReviews,
      trainer_rating: r ? round2(r.trainer_rating) : null,
    };
  });

  const countOf = (cat) => assignments.filter((a) => a.category === cat).length;

  return {
    ...publicTrainer(row.t, row.u),
    rating: {
      reviews,
      trainer_rating: round2(overall.trainer_rating),
      overall_rating: round2(overall.overall_rating),
      content_rating: round2(overall.content_rating),
      recommend_pct: reviews > 0 ? Math.round((Number(overall.recommend || 0) / reviews) * 100) : null,
    },
    summary: {
      total: assignments.length,
      completed: countOf("completed"),
      ongoing: countOf("ongoing"),
      upcoming: countOf("upcoming"),
      cancelled: countOf("cancelled"),
      total_participants: assignments.reduce((s, a) => s + (a.enrolled_count || 0), 0),
    },
    assignments,
  };
}

export async function updateTrainer(adminId, trainerId, body, ip) {
  return db.transaction(async (tx) => {
    const [trainer] = await tx.select().from(trainers).where(eq(trainers.id, trainerId)).limit(1);
    if (!trainer) throw new AppError("Trainer not found", 404);

    const before = {
      bio: trainer.bio,
      experience: trainer.experience,
      rate: trainer.rate,
      certificates: trainer.certificates,
      specializations: trainer.specializations,
      city: trainer.city,
      country: trainer.country,
      is_remote: trainer.isRemote,
      is_active: trainer.isActive,
    };

    const set = { updatedAt: new Date() };
    if (body.bio !== undefined) set.bio = body.bio;
    if (body.experience !== undefined) set.experience = body.experience;
    if (body.rate !== undefined) set.rate = body.rate != null ? String(body.rate) : null;
    if (body.certificates !== undefined) set.certificates = body.certificates;
    if (body.specializations !== undefined) set.specializations = body.specializations;
    if (body.city !== undefined) set.city = body.city;
    if (body.country !== undefined) set.country = body.country;
    if (body.is_remote !== undefined) set.isRemote = body.is_remote;
    if (body.is_active !== undefined) set.isActive = body.is_active;
    await tx.update(trainers).set(set).where(eq(trainers.id, trainerId));

    // Name / email live on the users account. Email is the login identity, so
    // guard against colliding with another account.
    const userSet = {};
    if (body.name !== undefined) userSet.name = body.name;
    if (body.email !== undefined) {
      const [current] = await tx.select({ email: users.email }).from(users).where(eq(users.id, trainer.userId)).limit(1);
      if (body.email !== current?.email) {
        const [dupe] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
        if (dupe && dupe.id !== trainer.userId) throw new AppError("That email is already in use by another account", 409);
        userSet.email = body.email;
      }
    }
    if (Object.keys(userSet).length) {
      await tx.update(users).set({ ...userSet, updatedAt: new Date() }).where(eq(users.id, trainer.userId));
    }

    await writeAudit(tx, {
      entityType: "trainer",
      entityId: trainerId,
      action: "trainer_updated",
      actorId: adminId,
      before,
      after: { ...set, ...userSet },
      ipAddress: ip,
    });

    const [updated] = await tx.select().from(trainers).where(eq(trainers.id, trainerId)).limit(1);
    const [u] = await tx.select().from(users).where(eq(users.id, trainer.userId)).limit(1);
    return publicTrainer(updated, u);
  });
}

/* ─────────────────────────────────────────────────────────
   Participant + enrolment management
   ───────────────────────────────────────────────────────── */

function publicParticipant(p) {
  return {
    id: p.id,
    user_id: p.userId,
    name: p.name,
    email: p.email,
    phone: p.phone,
    job_title: p.jobTitle,
  };
}

async function refreshEnrolledCount(tx, trainingId) {
  const res = await tx.execute(
    sql`SELECT count(*)::int AS n FROM enrolments WHERE training_id = ${trainingId} AND status = 'confirmed'`
  );
  await tx
    .update(trainingIds)
    .set({ enrolledCount: res.rows?.[0]?.n ?? 0, updatedAt: new Date() })
    .where(eq(trainingIds.id, trainingId));
}

// List all participants for the admin dashboard, paginated + optional search
// (by name or email). Enriched with confirmed-enrolment count and account
// status (has_password = false means their setup email is still pending).
export async function listParticipants({ search, page, limit, location, job_title }) {
  const offset = (page - 1) * limit;

  // "city, country" — skips NULL parts, empty → NULL. Mirrors the display join.
  const locationExpr = sql`nullif(concat_ws(', ', ${participants.city}, ${participants.country}), '')`;

  const conditions = [];
  if (search) {
    conditions.push(
      or(ilike(participants.name, `%${search}%`), ilike(participants.email, `%${search}%`))
    );
  }
  if (job_title) conditions.push(eq(participants.jobTitle, job_title));
  if (location) conditions.push(eq(locationExpr, location));
  const where = conditions.length ? and(...conditions) : undefined;

  const enrolmentCount = sql`(
    SELECT count(*)::int FROM enrolments e
    WHERE e.participant_id = ${participants.id} AND e.status = 'confirmed'
  )`;

  const rows = await db
    .select({
      id: participants.id,
      name: participants.name,
      email: participants.email,
      phone: participants.phone,
      jobTitle: participants.jobTitle,
      city: participants.city,
      country: participants.country,
      createdAt: participants.createdAt,
      accountActive: users.isActive,
      hasPassword: sql`(${users.passwordHash} IS NOT NULL)`,
      enrolmentCount,
    })
    .from(participants)
    .leftJoin(users, eq(participants.userId, users.id))
    .where(where)
    .orderBy(asc(participants.name))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql`count(*)::int` })
    .from(participants)
    .where(where);

  // Distinct filter options across ALL participants (independent of the current
  // search/filter/page) so the dropdowns stay complete.
  const jobTitleRows = await db
    .selectDistinct({ value: participants.jobTitle })
    .from(participants)
    .where(sql`${participants.jobTitle} is not null and ${participants.jobTitle} <> ''`)
    .orderBy(asc(participants.jobTitle));
  const locationRows = await db
    .selectDistinct({ value: locationExpr })
    .from(participants)
    .where(sql`${locationExpr} is not null`)
    .orderBy(asc(locationExpr));

  return {
    participants: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      job_title: r.jobTitle,
      city: r.city,
      country: r.country,
      location: [r.city, r.country].filter(Boolean).join(", ") || null,
      enrolment_count: r.enrolmentCount,
      account_active: r.accountActive ?? false,
      has_password: r.hasPassword ?? false,
      created_at: r.createdAt,
    })),
    total: count,
    page,
    limit,
    filters: {
      job_titles: jobTitleRows.map((r) => r.value).filter(Boolean),
      locations: locationRows.map((r) => r.value).filter(Boolean),
    },
  };
}

// Bucket an enrolment into a display category for the participant detail view.
// Combines the enrolment status with the training's own lifecycle status so the
// admin can tell completed vs still-upcoming vs in-progress trainings apart.
function enrolmentCategory(enrolStatus, trainingStatus) {
  if (enrolStatus === "completed") return "completed";
  if (enrolStatus === "cancelled") return "cancelled";
  if (enrolStatus === "transferred") return "transferred";
  if (enrolStatus === "failed") return "failed";
  // status === 'confirmed' — split by where the training itself is
  if (trainingStatus === "ongoing") return "ongoing";
  return "upcoming";
}

// Full profile for a single participant plus every training they enrolled in,
// each tagged with a display category (completed / ongoing / upcoming /
// cancelled / transferred / failed) and whether a certificate was issued.
// Powers the admin User Management → click-through detail drawer.
export async function getParticipantDetail(participantId) {
  const [p] = await db
    .select({
      id: participants.id,
      userId: participants.userId,
      name: participants.name,
      email: participants.email,
      phone: participants.phone,
      jobTitle: participants.jobTitle,
      city: participants.city,
      country: participants.country,
      createdAt: participants.createdAt,
      accountActive: users.isActive,
      hasPassword: sql`(${users.passwordHash} IS NOT NULL)`,
      companyName: userProfiles.companyName,
      department: userProfiles.department,
      yearsExperience: userProfiles.yearsExperience,
      linkedinUrl: userProfiles.linkedinUrl,
    })
    .from(participants)
    .leftJoin(users, eq(participants.userId, users.id))
    .leftJoin(userProfiles, eq(participants.userId, userProfiles.userId))
    .where(eq(participants.id, participantId))
    .limit(1);

  if (!p) throw new AppError("Participant not found", 404);

  const rows = await db
    .select({
      enrolmentId: enrolments.id,
      status: enrolments.status,
      attendanceStatus: enrolments.attendanceStatus,
      enrolledAt: enrolments.enrolledAt,
      orderId: enrolments.orderId,
      trainingId: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      bucket: trainingIds.bucket,
      deliveryMode: trainingIds.deliveryMode,
      trainingStatus: trainingIds.status,
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      certificateCode: certificates.certificateCode,
    })
    .from(enrolments)
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .leftJoin(certificates, eq(certificates.enrolmentId, enrolments.id))
    .where(eq(enrolments.participantId, participantId))
    .orderBy(desc(enrolments.enrolledAt));

  const enrolled = rows.map((r) => ({
    enrolment_id: r.enrolmentId,
    training_id: r.trainingId,
    training_code: r.code,
    title: r.title,
    bucket: r.bucket,
    delivery_mode: r.deliveryMode,
    training_status: r.trainingStatus,
    status: r.status,
    attendance_status: r.attendanceStatus,
    start_date: r.startDate,
    end_date: r.endDate,
    enrolled_at: r.enrolledAt,
    added_manually: r.orderId == null,
    certificate_issued: r.certificateCode != null,
    certificate_code: r.certificateCode ?? null,
    category: enrolmentCategory(r.status, r.trainingStatus),
  }));

  const countOf = (...cats) => enrolled.filter((e) => cats.includes(e.category)).length;

  return {
    participant: {
      id: p.id,
      user_id: p.userId,
      name: p.name,
      email: p.email,
      phone: p.phone,
      job_title: p.jobTitle,
      city: p.city,
      country: p.country,
      location: [p.city, p.country].filter(Boolean).join(", ") || null,
      company_name: p.companyName ?? null,
      department: p.department ?? null,
      years_experience: p.yearsExperience ?? null,
      linkedin_url: p.linkedinUrl ?? null,
      account_active: p.accountActive ?? false,
      has_password: p.hasPassword ?? false,
      created_at: p.createdAt,
    },
    enrolments: enrolled,
    summary: {
      total: enrolled.length,
      completed: countOf("completed"),
      ongoing: countOf("ongoing"),
      upcoming: countOf("upcoming"),
      inactive: countOf("cancelled", "transferred", "failed"),
      certificates: enrolled.filter((e) => e.certificate_issued).length,
    },
  };
}

// Edit participant details (name/phone/job_title). Email is the login identity
// and is intentionally not editable here. Name is synced to the linked account.
export async function updateParticipant(adminId, participantId, body, ip) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(participants).where(eq(participants.id, participantId)).limit(1);
    if (!p) throw new AppError("Participant not found", 404);

    const before = { name: p.name, phone: p.phone, job_title: p.jobTitle };
    const set = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.phone !== undefined) set.phone = body.phone;
    if (body.job_title !== undefined) set.jobTitle = body.job_title;
    await tx.update(participants).set(set).where(eq(participants.id, participantId));

    if (body.name !== undefined && p.userId) {
      await tx
        .update(users)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(users.id, p.userId));
    }

    await writeAudit(tx, {
      entityType: "participant",
      entityId: participantId,
      action: "participant_updated",
      actorId: adminId,
      before,
      after: { name: body.name, phone: body.phone, job_title: body.job_title },
      ipAddress: ip,
    });

    const [updated] = await tx.select().from(participants).where(eq(participants.id, participantId)).limit(1);
    return publicParticipant(updated);
  });
}

// Cancel an enrolment (reason required, audited; frees the seat).
export async function cancelEnrolment(adminId, enrolmentId, reason, ip) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(enrolments).where(eq(enrolments.id, enrolmentId)).limit(1);
    if (!e) throw new AppError("Enrolment not found", 404);
    if (e.status === "cancelled") throw new AppError("Enrolment is already cancelled", 409);

    await tx
      .update(enrolments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(enrolments.id, enrolmentId));
    await refreshEnrolledCount(tx, e.trainingId);

    await writeAudit(tx, {
      entityType: "enrolment",
      entityId: enrolmentId,
      action: "enrolment_cancelled",
      actorId: adminId,
      before: { status: e.status },
      after: { status: "cancelled" },
      reason,
      ipAddress: ip,
    });

    return { id: enrolmentId, status: "cancelled" };
  });
}

// Mark a single enrolment 'completed' — the learner successfully finished the
// training. This is the anchor for certificate eligibility in the learner
// portal (see learner.service isFinished/certificates). One-way: only a
// 'confirmed' enrolment can be completed, and it stays completed.
// Completion is not a seat event (unlike cancel/transfer), so enrolled_count
// is intentionally left untouched.
export async function completeEnrolment(adminId, enrolmentId, ip) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(enrolments).where(eq(enrolments.id, enrolmentId)).limit(1);
    if (!e) throw new AppError("Enrolment not found", 404);
    if (e.status === "completed") throw new AppError("Enrolment is already completed", 409);
    if (e.status !== "confirmed") {
      throw new AppError("Only a confirmed enrolment can be marked completed", 422);
    }

    await tx
      .update(enrolments)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(enrolments.id, enrolmentId));

    await writeAudit(tx, {
      entityType: "enrolment",
      entityId: enrolmentId,
      action: "enrolment_completed",
      actorId: adminId,
      before: { status: e.status },
      after: { status: "completed" },
      ipAddress: ip,
    });

    // If the learner already submitted the post-training survey, issue the
    // certificate now (it was gated on completion).
    const [resp] = await tx
      .select({ answers: surveyResponses.answers })
      .from(surveyResponses)
      .innerJoin(surveys, eq(surveyResponses.surveyId, surveys.id))
      .where(
        and(
          eq(surveys.trainingId, e.trainingId),
          eq(surveys.type, "post_training"),
          eq(surveyResponses.participantId, e.participantId)
        )
      )
      .limit(1);
    if (resp) {
      await issueCertificate(tx, {
        enrolmentId: e.id,
        trainingId: e.trainingId,
        surveyResponses: resp.answers,
      });
    }

    return { id: enrolmentId, status: "completed" };
  });
}

// Bulk-complete every currently-confirmed enrolment in a training (the "mark
// all completed" action). Already-completed and non-confirmed (cancelled /
// transferred / failed) enrolments are left as-is. Returns how many were
// completed so the UI can report it.
export async function completeAllEnrolments(adminId, trainingRef, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);

    const updated = await tx
      .update(enrolments)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(enrolments.trainingId, training.id), eq(enrolments.status, "confirmed")))
      .returning({ id: enrolments.id, participantId: enrolments.participantId });

    if (updated.length > 0) {
      await writeAudit(tx, {
        entityType: "training_id",
        entityId: training.id,
        action: "enrolments_bulk_completed",
        actorId: adminId,
        after: { training_code: training.code, completed: updated.length },
        ipAddress: ip,
      });

      // Issue certificates for those who already submitted the post-training survey.
      const responded = await tx
        .select({ participantId: surveyResponses.participantId, answers: surveyResponses.answers })
        .from(surveyResponses)
        .innerJoin(surveys, eq(surveyResponses.surveyId, surveys.id))
        .where(and(eq(surveys.trainingId, training.id), eq(surveys.type, "post_training")));
      const answersByParticipant = new Map(responded.map((r) => [r.participantId, r.answers]));
      for (const u of updated) {
        const answers = answersByParticipant.get(u.participantId);
        if (answers) {
          await issueCertificate(tx, { enrolmentId: u.id, trainingId: training.id, surveyResponses: answers });
        }
      }
    }

    return { training_id: training.code, completed: updated.length };
  });
}

/* ─────────────────────────────────────────────────────────
   Admin dashboard — a single overview snapshot for the landing page.
   Aggregates users, trainers, courses (Training IDs), enrolments,
   certificates and (placeholder) support tickets, plus a few preview
   lists (upcoming / completed trainings, recent enrolments & trainers).
   ───────────────────────────────────────────────────────── */

// Maps a joined training row to the compact card shape used by the preview
// lists (mirrors the shape of GET /api/admin/trainings).
function dashboardTrainingCard(r) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status,
    delivery_mode: r.deliveryMode,
    bucket: r.bucket,
    capacity: r.capacity,
    enrolled_count: r.enrolledCount,
    start_date: r.startDate,
    end_date: r.endDate,
    timezone: r.timezone,
    duration_hours: r.durationHours ?? null,
    daily_hours: r.dailyHours ?? null,
    location: r.location ?? null,
    trainer_assigned: r.trainerName != null,
    trainer_name: r.trainerName ?? null,
  };
}

export async function getDashboard() {
  // Base select + joins shared by both training preview lists.
  const trainingCardSelect = {
    id: trainingIds.id,
    code: trainingIds.code,
    title: trainingIds.title,
    status: trainingIds.status,
    deliveryMode: trainingIds.deliveryMode,
    bucket: trainingIds.bucket,
    capacity: trainingIds.capacity,
    enrolledCount: trainingIds.enrolledCount,
    startDate: schedules.startDate,
    endDate: schedules.endDate,
    timezone: schedules.timezone,
    durationHours: schedules.durationHours,
    dailyHours: sql`round(extract(epoch from (${schedules.endTime} - ${schedules.startTime})) / 3600)::int`,
    location: sql`coalesce(${schedules.venue}->>'city', case when ${trainingIds.deliveryMode} is not null then 'Virtual / Online' end)`,
    trainerName: users.name,
  };
  const trainingCardFrom = (qb) =>
    qb
      .from(trainingIds)
      .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
      .leftJoin(
        trainerAssignments,
        and(eq(trainerAssignments.trainingId, trainingIds.id), isNull(trainerAssignments.removedAt))
      )
      .leftJoin(trainers, eq(trainerAssignments.trainerId, trainers.id))
      .leftJoin(users, eq(trainers.userId, users.id));

  const [
    userRows,
    [trainerAgg],
    [{ assignedTrainers }],
    [{ participantsTotal }],
    statusRows,
    [courseAgg],
    [{ upcomingCourses }],
    enrolRows,
    upcomingRows,
    completedRows,
    recentEnrolments,
    recentTrainers,
  ] = await Promise.all([
    // Users grouped by role, with active / pending-setup breakdown.
    db
      .select({
        role: users.role,
        total: sql`count(*)::int`,
        active: sql`count(*) filter (where ${users.isActive})::int`,
        pendingSetup: sql`count(*) filter (where ${users.passwordHash} is null)::int`,
      })
      .from(users)
      .groupBy(users.role),

    // Trainer profile aggregates (certificates are a jsonb array on each row).
    db
      .select({
        total: sql`count(*)::int`,
        active: sql`count(*) filter (where ${trainers.isActive})::int`,
        totalCertificates: sql`coalesce(sum(jsonb_array_length(${trainers.certificates})), 0)::int`,
      })
      .from(trainers),

    // Trainers holding at least one currently-active assignment.
    db
      .select({ assignedTrainers: sql`count(distinct ${trainerAssignments.trainerId})::int` })
      .from(trainerAssignments)
      .where(isNull(trainerAssignments.removedAt)),

    db.select({ participantsTotal: sql`count(*)::int` }).from(participants),

    // Trainings (courses) grouped by lifecycle status.
    db
      .select({ status: trainingIds.status, count: sql`count(*)::int` })
      .from(trainingIds)
      .groupBy(trainingIds.status),

    // Course totals: seats offered vs filled, meeting links released.
    db
      .select({
        total: sql`count(*)::int`,
        totalCapacity: sql`coalesce(sum(${trainingIds.capacity}), 0)::int`,
        totalEnrolled: sql`coalesce(sum(${trainingIds.enrolledCount}), 0)::int`,
        meetingReleased: sql`count(*) filter (where ${trainingIds.meetingReleased})::int`,
      })
      .from(trainingIds),

    // Upcoming = scheduled to start today or later and not cancelled/completed.
    db
      .select({ upcomingCourses: sql`count(*)::int` })
      .from(trainingIds)
      .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
      .where(
        and(
          sql`${schedules.startDate} >= current_date`,
          sql`${trainingIds.status} not in ('cancelled', 'completed')`
        )
      ),

    // Enrolments grouped by status (confirmed / completed / cancelled / …).
    db
      .select({ status: enrolments.status, count: sql`count(*)::int` })
      .from(enrolments)
      .groupBy(enrolments.status),

    // Preview: next trainings to start.
    trainingCardFrom(db.select(trainingCardSelect))
      .where(
        and(
          sql`${schedules.startDate} >= current_date`,
          sql`${trainingIds.status} not in ('cancelled', 'completed')`
        )
      )
      .orderBy(asc(schedules.startDate))
      .limit(8),

    // Preview: most recently completed trainings.
    trainingCardFrom(db.select(trainingCardSelect))
      .where(eq(trainingIds.status, "completed"))
      .orderBy(desc(trainingIds.updatedAt))
      .limit(8),

    // Preview: latest enrolments across all trainings (enriched for the
    // dashboard table — schedule date, delivery mode, total & daily hours).
    db
      .select({
        enrolmentId: enrolments.id,
        status: enrolments.status,
        enrolledAt: enrolments.enrolledAt,
        participantName: participants.name,
        participantEmail: participants.email,
        trainingCode: trainingIds.code,
        trainingTitle: trainingIds.title,
        deliveryMode: trainingIds.deliveryMode,
        startDate: schedules.startDate,
        endDate: schedules.endDate,
        durationHours: schedules.durationHours,
        dailyHours: sql`round(extract(epoch from (${schedules.endTime} - ${schedules.startTime})) / 3600)::int`,
        location: sql`coalesce(${participants.city}, ${participants.country})`,
      })
      .from(enrolments)
      .innerJoin(participants, eq(enrolments.participantId, participants.id))
      .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
      .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
      .orderBy(desc(enrolments.enrolledAt))
      .limit(10),

    // Preview: most recently onboarded trainers, enriched with their latest
    // assigned training (learners, location, mode, hours, dates) for the table.
    db.execute(sql`
      select tr.id, u.name, tr.is_active, tr.created_at,
        ti.delivery_mode, ti.enrolled_count as learners,
        s.start_date, s.end_date, s.duration_hours,
        round(mod(extract(epoch from (s.end_time - s.start_time))::numeric + 86400, 86400) / 3600)::int as daily_hours,
        coalesce(s.venue->>'city', case when ti.delivery_mode is not null then 'Virtual / Online' end) as location
      from trainers tr
      join users u on u.id = tr.user_id
      left join lateral (
        select ta.training_id from trainer_assignments ta
        where ta.trainer_id = tr.id and ta.removed_at is null
        order by ta.assigned_at desc limit 1
      ) la on true
      left join training_ids ti on ti.id = la.training_id
      left join schedules s on s.id = ti.schedule_id
      order by tr.created_at desc
      limit 6
    `),
  ]);

  // ── Fold the grouped rows into flat maps ──
  const roleTemplate = { admin: 0, trainer: 0, sponsor: 0, learner: 0 };
  const byRole = { ...roleTemplate };
  let usersTotal = 0;
  let usersActive = 0;
  let pendingSetup = 0;
  for (const r of userRows) {
    byRole[r.role] = r.total;
    usersTotal += r.total;
    usersActive += r.active;
    pendingSetup += r.pendingSetup;
  }

  const statusTemplate = { pending: 0, active: 0, ongoing: 0, completed: 0, cancelled: 0, postponed: 0, suspended: 0 };
  const coursesByStatus = { ...statusTemplate };
  for (const r of statusRows) coursesByStatus[r.status] = r.count;

  const enrolTemplate = { confirmed: 0, cancelled: 0, transferred: 0, completed: 0, failed: 0 };
  const enrolByStatus = { ...enrolTemplate };
  let enrolTotal = 0;
  for (const r of enrolRows) {
    enrolByStatus[r.status] = r.count;
    enrolTotal += r.count;
  }

  const totalCapacity = courseAgg.totalCapacity;
  const totalEnrolled = courseAgg.totalEnrolled;

  // ── Action items: what the admin needs to act on right now ──
  const [awaitingRes, releasableRes, underfilledRes, pendingSetupRes] = await Promise.all([
    // Live trainings with no trainer assigned.
    db.execute(sql`
      select ti.id, ti.code, ti.title, s.start_date
      from training_ids ti
      left join schedules s on s.id = ti.schedule_id
      where ti.status not in ('cancelled', 'completed')
        and not exists (
          select 1 from trainer_assignments ta
          where ta.training_id = ti.id and ta.removed_at is null)
      order by s.start_date asc nulls last
    `),
    // Meeting link ready to release: starting within 14 days, min seats met, not yet released.
    db.execute(sql`
      select ti.id, ti.code, ti.title, ti.enrolled_count, ti.min_seats, s.start_date
      from training_ids ti
      join schedules s on s.id = ti.schedule_id
      where ti.status not in ('cancelled', 'completed')
        and ti.meeting_released = false
        and ti.enrolled_count >= ti.min_seats
        and s.start_date >= current_date
        and s.start_date <= current_date + interval '14 days'
      order by s.start_date asc
    `),
    // Under-enrolled and starting soon (below min seats within 21 days) — at risk.
    db.execute(sql`
      select ti.id, ti.code, ti.title, ti.enrolled_count, ti.min_seats, ti.capacity, s.start_date
      from training_ids ti
      join schedules s on s.id = ti.schedule_id
      where ti.status not in ('cancelled', 'completed')
        and ti.enrolled_count < ti.min_seats
        and s.start_date >= current_date
        and s.start_date <= current_date + interval '21 days'
      order by s.start_date asc
    `),
    // Learner accounts awaiting activation (no password set yet).
    db.execute(sql`
      select p.id, p.name, p.email, p.created_at
      from participants p
      left join users u on u.id = p.user_id
      where p.user_id is null or u.password_hash is null
      order by p.created_at desc
      limit 6
    `),
  ]);

  const actionItems = {
    awaiting_trainer: {
      count: awaitingRes.rows.length,
      items: awaitingRes.rows.slice(0, 5).map((r) => ({
        id: r.id, code: r.code, title: r.title, start_date: r.start_date,
      })),
    },
    release_meeting: {
      count: releasableRes.rows.length,
      items: releasableRes.rows.slice(0, 5).map((r) => ({
        id: r.id, code: r.code, title: r.title, start_date: r.start_date,
        enrolled_count: r.enrolled_count, min_seats: r.min_seats,
      })),
    },
    under_enrolled: {
      count: underfilledRes.rows.length,
      items: underfilledRes.rows.slice(0, 5).map((r) => ({
        id: r.id, code: r.code, title: r.title, start_date: r.start_date,
        enrolled_count: r.enrolled_count, min_seats: r.min_seats, capacity: r.capacity,
      })),
    },
    pending_setup: {
      count: pendingSetup,
      items: pendingSetupRes.rows.map((r) => ({ id: r.id, name: r.name, email: r.email })),
    },
  };

  return {
    generated_at: new Date().toISOString(),
    action_items: actionItems,
    users: {
      total: usersTotal,
      active: usersActive,
      inactive: usersTotal - usersActive,
      pending_setup: pendingSetup, // accounts with no password yet (setup email pending)
      by_role: byRole,
      participants_total: participantsTotal,
    },
    trainers: {
      total: trainerAgg.total,
      active: trainerAgg.active,
      inactive: trainerAgg.total - trainerAgg.active,
      assigned: assignedTrainers, // currently hold at least one active assignment
      unassigned: trainerAgg.total - assignedTrainers,
      total_certificates: trainerAgg.totalCertificates,
    },
    courses: {
      total: courseAgg.total,
      by_status: coursesByStatus,
      upcoming: upcomingCourses,
      ongoing: coursesByStatus.ongoing,
      completed: coursesByStatus.completed,
      meeting_released: courseAgg.meetingReleased,
      total_capacity: totalCapacity,
      total_enrolled: totalEnrolled,
      fill_rate: totalCapacity > 0 ? Math.round((totalEnrolled / totalCapacity) * 100) / 100 : 0,
    },
    enrolments: {
      total: enrolTotal,
      confirmed: enrolByStatus.confirmed,
      completed: enrolByStatus.completed,
      cancelled: enrolByStatus.cancelled,
      transferred: enrolByStatus.transferred,
      failed: enrolByStatus.failed,
    },
    certificates: {
      // No dedicated certificate store yet — a learner who completes a training
      // is treated as having earned one, so completed enrolments are the proxy.
      issued: enrolByStatus.completed,
      trainer_certificates: trainerAgg.totalCertificates,
      note: "Derived from completed enrolments; a dedicated certificate store is not yet implemented.",
    },
    tickets: {
      // Support ticketing is not built yet — static placeholder so the dashboard
      // card can render. Replace with live counts once the feature lands.
      supported: false,
      total: 0,
      open: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0,
      note: "Support ticketing is not yet available; showing placeholder values.",
    },
    upcoming_trainings: upcomingRows.map(dashboardTrainingCard),
    completed_trainings: completedRows.map(dashboardTrainingCard),
    recent_enrolments: recentEnrolments.map((e) => ({
      enrolment_id: e.enrolmentId,
      status: e.status,
      enrolled_at: e.enrolledAt,
      participant_name: e.participantName,
      participant_email: e.participantEmail,
      training_code: e.trainingCode,
      training_title: e.trainingTitle,
      delivery_mode: e.deliveryMode,
      start_date: e.startDate,
      end_date: e.endDate,
      duration_hours: e.durationHours,
      daily_hours: e.dailyHours,
      location: e.location,
    })),
    recent_trainers: recentTrainers.rows.map((t) => ({
      id: t.id,
      name: t.name,
      is_active: t.is_active,
      created_at: t.created_at,
      learners: t.learners,
      location: t.location,
      delivery_mode: t.delivery_mode,
      duration_hours: t.duration_hours,
      daily_hours: t.daily_hours,
      start_date: t.start_date,
      end_date: t.end_date,
    })),
  };
}

// Transfer a participant to another training (reason required, audited). Marks
// the source enrolment 'transferred' and creates a new confirmed enrolment in
// the target, preserving the sponsoring order link.
export async function transferEnrolment(adminId, enrolmentId, targetRef, reason, ip) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(enrolments).where(eq(enrolments.id, enrolmentId)).limit(1);
    if (!e) throw new AppError("Enrolment not found", 404);
    if (e.status !== "confirmed") {
      throw new AppError("Only a confirmed enrolment can be transferred", 409);
    }

    const target = await resolveTraining(tx, targetRef);
    if (target.id === e.trainingId) {
      throw new AppError("Cannot transfer to the same training", 422);
    }
    if (target.capacity != null && target.enrolledCount >= target.capacity) {
      throw new AppError("Target training is at full capacity", 422);
    }

    const [dup] = await tx
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.trainingId, target.id),
          eq(enrolments.participantId, e.participantId),
          sql`status NOT IN ('cancelled', 'transferred')`
        )
      )
      .limit(1);
    if (dup) throw new AppError("Participant is already enrolled in the target training", 409);

    await tx
      .update(enrolments)
      .set({ status: "transferred", updatedAt: new Date() })
      .where(eq(enrolments.id, enrolmentId));

    const [created] = await tx
      .insert(enrolments)
      .values({
        trainingId: target.id,
        participantId: e.participantId,
        orderId: e.orderId,
        status: "confirmed",
      })
      .returning();

    await refreshEnrolledCount(tx, e.trainingId);
    await refreshEnrolledCount(tx, target.id);

    await writeAudit(tx, {
      entityType: "enrolment",
      entityId: enrolmentId,
      action: "enrolment_transferred",
      actorId: adminId,
      before: { training_id: e.trainingId, status: "confirmed" },
      after: { training_id: target.id, new_enrolment_id: created.id, status: "transferred" },
      reason,
      ipAddress: ip,
    });

    return {
      from_enrolment_id: enrolmentId,
      to_enrolment_id: created.id,
      to_training: target.code,
      status: "transferred",
    };
  });
}

/* ─────────────────────────────────────────────────────────
   Admin analytics — a rich, FILTERABLE snapshot powering the
   dynamic charts on the admin dashboard. Every dataset honours the
   same filter set:
     from / to        → date range (applied per-dataset to its own
                          natural date column: schedule start for
                          trainings, enrolled_at for enrolments,
                          created_at for participants, session start
                          for sessions).
     delivery_mode    → training delivery mode
     bucket           → training bucket (offering type)
     status           → training lifecycle status
     trainer_id       → only trainings currently assigned to that trainer
   Categorical filters resolve against the training a record belongs to.
   ───────────────────────────────────────────────────────── */
export async function getAnalytics(filters = {}) {
  const f = filters;

  // Categorical training filter as a reusable WHERE fragment, parameterised by
  // the alias the training row is exposed under in each query. Enum columns are
  // cast to text so bound string params compare cleanly.
  const trainingConds = (alias) => {
    const a = sql.raw(alias);
    const c = [sql`true`];
    if (f.status) c.push(sql`${a}.status::text = ${f.status}`);
    if (f.delivery_mode) c.push(sql`${a}.delivery_mode::text = ${f.delivery_mode}`);
    if (f.bucket) c.push(sql`${a}.bucket::text = ${f.bucket}`);
    if (f.trainer_id)
      c.push(sql`exists (
        select 1 from trainer_assignments ta
        where ta.training_id = ${a}.id
          and ta.trainer_id = ${f.trainer_id}
          and ta.removed_at is null)`);
    if (f.duration)
      c.push(sql`exists (
        select 1 from schedules s
        where s.id = ${a}.schedule_id
          and round(mod(extract(epoch from (s.end_time - s.start_time))::numeric + 86400, 86400) / 3600)::int = ${f.duration})`);
    return sql.join(c, sql` and `);
  };

  // Date-range fragment against a column expression (cast: 'date' | 'timestamptz').
  const dateConds = (colExpr, cast) => {
    const c = [sql`true`];
    if (f.from) c.push(sql`${colExpr} >= ${f.from}::${sql.raw(cast)}`);
    if (f.to) c.push(sql`${colExpr} <= ${f.to}::${sql.raw(cast)}`);
    return sql.join(c, sql` and `);
  };

  const trainerScope = [sql`true`];
  if (f.trainer_id) trainerScope.push(sql`tr.id = ${f.trainer_id}`);
  const trainerScopeSql = sql.join(trainerScope, sql` and `);

  // Learner-attribute filters (location, sponsorship, job title, department) live
  // on the enrolment/participant, not the training — so they scope enrolment-grain
  // datasets via the participants join (alias p / enrolments alias e), never the
  // training-level ones.
  const enrolFilters = [sql`true`];
  if (f.location) enrolFilters.push(sql`p.country = ${f.location}`);
  if (f.sponsorship) enrolFilters.push(sql`e.sponsorship = ${f.sponsorship}`);
  if (f.job_title) enrolFilters.push(sql`p.job_title = ${f.job_title}`);
  if (f.department) enrolFilters.push(sql`p.department = ${f.department}`);
  const enrolCond = sql.join(enrolFilters, sql` and `);

  // Revenue counts only money that actually landed — confirmed/completed seats.
  const paidRevenue = sql`coalesce(sum(e.amount) filter (where e.status in ('confirmed', 'completed')), 0)::float`;

  const [
    trainingsRes,
    enrolSummaryRes,
    enrolMonthlyRes,
    participantMonthlyRes,
    trainerSummaryRes,
    topTrainersRes,
    sessionSummaryRes,
    sessionMonthlyRes,
    trainerOptionsRes,
    courseDemandRes,
    attendanceRes,
    durationRes,
    locationRes,
    tierRes,
    revenueByCourseRes,
    locationOptionsRes,
    durationOptionsRes,
    sponsorshipRes,
    jobTitleRes,
    departmentRes,
    experienceRes,
    companiesRes,
    jobTitleOptionsRes,
    departmentOptionsRes,
  ] = await Promise.all([
    // Trainings (with schedule + active trainer) — drives most training charts,
    // capacity, the upcoming list and the training KPIs.
    db.execute(sql`
      select ti.id, ti.code, ti.title, ti.status::text as status,
             ti.delivery_mode::text as delivery_mode, ti.bucket::text as bucket,
             ti.capacity, ti.enrolled_count,
             s.start_date, s.end_date, s.timezone,
             u.name as trainer_name
      from training_ids ti
      left join schedules s on s.id = ti.schedule_id
      left join trainer_assignments ta on ta.training_id = ti.id and ta.removed_at is null
      left join trainers tr on tr.id = ta.trainer_id
      left join users u on u.id = tr.user_id
      where ${trainingConds("ti")} and ${dateConds(sql`s.start_date`, "date")}
      order by s.start_date asc nulls last
    `),

    // Enrolment totals + status split + distinct participants + revenue.
    db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where e.status = 'confirmed')::int   as confirmed,
        count(*) filter (where e.status = 'completed')::int   as completed,
        count(*) filter (where e.status = 'cancelled')::int   as cancelled,
        count(*) filter (where e.status = 'transferred')::int as transferred,
        count(*) filter (where e.status = 'failed')::int      as failed,
        count(distinct e.participant_id)::int as participants,
        ${paidRevenue} as revenue
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
    `),

    // Enrolments + revenue per month (time series).
    db.execute(sql`
      select to_char(date_trunc('month', e.enrolled_at), 'YYYY-MM') as month,
        count(*)::int as total,
        count(*) filter (where e.status = 'confirmed')::int   as confirmed,
        count(*) filter (where e.status = 'completed')::int   as completed,
        count(*) filter (where e.status = 'cancelled')::int   as cancelled,
        count(*) filter (where e.status = 'transferred')::int as transferred,
        count(*) filter (where e.status = 'failed')::int      as failed,
        ${paidRevenue} as revenue
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 1
    `),

    // New participant accounts per month (date-filtered by created_at only —
    // participants are not directly bound to a single training).
    db.execute(sql`
      select to_char(date_trunc('month', p.created_at), 'YYYY-MM') as month,
             count(*)::int as new_count
      from participants p
      where ${dateConds(sql`p.created_at`, "timestamptz")}
      group by 1 order by 1
    `),

    // Trainer totals (respects trainer_id filter).
    db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where tr.is_active)::int as active,
        count(*) filter (where exists (
          select 1 from trainer_assignments ta
          where ta.trainer_id = tr.id and ta.removed_at is null))::int as assigned
      from trainers tr
      where ${trainerScopeSql}
    `),

    // Top trainers by load (trainings assigned + participants trained).
    db.execute(sql`
      select tr.id, u.name, tr.is_active,
        count(distinct ti.id)::int as trainings,
        coalesce(sum(ti.enrolled_count), 0)::int as participants
      from trainers tr
      join users u on u.id = tr.user_id
      left join trainer_assignments ta on ta.trainer_id = tr.id and ta.removed_at is null
      left join training_ids ti on ti.id = ta.training_id and ${trainingConds("ti")}
      where ${trainerScopeSql}
      group by tr.id, u.name, tr.is_active
      order by trainings desc, participants desc
      limit 8
    `),

    // Session totals + status split.
    db.execute(sql`
      select count(*)::int as total,
        count(*) filter (where ts.status = 'scheduled')::int as scheduled,
        count(*) filter (where ts.status = 'ongoing')::int   as ongoing,
        count(*) filter (where ts.status = 'completed')::int as completed,
        count(*) filter (where ts.status = 'cancelled')::int as cancelled
      from training_sessions ts
      join training_ids ti on ti.id = ts.training_id
      where ${trainingConds("ti")} and ${dateConds(sql`ts.start_time`, "timestamptz")}
    `),

    // Sessions per month (time series).
    db.execute(sql`
      select to_char(date_trunc('month', ts.start_time), 'YYYY-MM') as month,
        count(*)::int as total,
        count(*) filter (where ts.status = 'completed')::int as completed,
        count(*) filter (where ts.status = 'scheduled')::int as scheduled
      from training_sessions ts
      join training_ids ti on ti.id = ts.training_id
      where ${trainingConds("ti")} and ${dateConds(sql`ts.start_time`, "timestamptz")}
      group by 1 order by 1
    `),

    // Active trainers for the filter dropdown.
    db.execute(sql`
      select tr.id, u.name from trainers tr
      join users u on u.id = tr.user_id
      where tr.is_active = true order by u.name
    `),

    // Course demand — which courses attract the most enrolment requests (+ revenue).
    db.execute(sql`
      select ti.title,
        count(*)::int as requests,
        count(distinct ti.id)::int as trainings,
        ${paidRevenue} as revenue
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by ti.title
      order by requests desc
      limit 8
    `),

    // Attendance — only meaningful for completed trainings.
    db.execute(sql`
      select
        count(*) filter (where e.attendance_status <> 'not_marked')::int as marked,
        count(*) filter (where e.attendance_status = 'present')::int as present,
        count(*) filter (where e.attendance_status = 'partial')::int as partial,
        count(*) filter (where e.attendance_status = 'absent')::int as absent
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ti.status = 'completed' and ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
    `),

    // Enrolments grouped by daily session length (hours/day).
    db.execute(sql`
      select round(mod(extract(epoch from (s.end_time - s.start_time))::numeric + 86400, 86400) / 3600)::int as hours,
        count(distinct ti.id)::int as trainings,
        count(e.id)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join schedules s on s.id = ti.schedule_id
      join participants p on p.id = e.participant_id
      where e.status not in ('cancelled', 'transferred')
        and ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 1
    `),

    // Enrolments + revenue grouped by LEARNER location (billing country).
    db.execute(sql`
      select coalesce(p.country, 'Unknown') as location,
        count(*)::int as enrolments,
        count(distinct ti.id)::int as trainings,
        ${paidRevenue} as revenue
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where e.status not in ('cancelled', 'transferred')
        and ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by enrolments desc
    `),

    // Enrolments + revenue grouped by pricing tier (xCRM package).
    db.execute(sql`
      select coalesce(e.pricing_tier, 'Unspecified') as tier,
        count(*)::int as enrolments,
        ${paidRevenue} as revenue
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by enrolments desc
    `),

    // Top courses by revenue.
    db.execute(sql`
      select ti.title, ${paidRevenue} as revenue, count(*)::int as requests
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by ti.title
      order by revenue desc
      limit 8
    `),

    // Filter dropdown options (filter-independent).
    db.execute(sql`
      select distinct country as location from participants
      where country is not null order by 1
    `),
    db.execute(sql`
      select distinct round(mod(extract(epoch from (end_time - start_time))::numeric + 86400, 86400) / 3600)::int as hours
      from schedules order by 1
    `),

    // ── Learner-profile analytics (enrolment grain) ──
    // Self-sponsored vs corporate.
    db.execute(sql`
      select coalesce(e.sponsorship, 'unspecified') as sponsorship, count(*)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 2 desc
    `),

    // By job title.
    db.execute(sql`
      select coalesce(p.job_title, 'Unspecified') as job_title, count(*)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 2 desc limit 8
    `),

    // By department.
    db.execute(sql`
      select coalesce(p.department, 'Unspecified') as department, count(*)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 2 desc limit 8
    `),

    // By experience bracket.
    db.execute(sql`
      select
        case
          when p.experience_years is null then 'Unknown'
          when p.experience_years <= 2 then '0-2 yrs'
          when p.experience_years <= 5 then '3-5 yrs'
          when p.experience_years <= 10 then '6-10 yrs'
          else '11+ yrs'
        end as bracket,
        min(p.experience_years) as sort,
        count(*)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by sort nulls last
    `),

    // Top companies (which corporate accounts send the most learners).
    db.execute(sql`
      select coalesce(p.company, 'Unspecified') as company, count(*)::int as enrolments
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${trainingConds("ti")} and ${enrolCond} and ${dateConds(sql`e.enrolled_at`, "timestamptz")}
      group by 1 order by 2 desc limit 8
    `),

    // Filter option lists.
    db.execute(sql`select distinct job_title as v from participants where job_title is not null order by 1`),
    db.execute(sql`select distinct department as v from participants where department is not null order by 1`),
  ]);

  // ── Fold the trainings rows into the training-centric datasets ──
  const trainings = trainingsRes.rows;
  const todayStr = new Date().toISOString().slice(0, 10);

  const statusTpl = { pending: 0, active: 0, ongoing: 0, completed: 0, cancelled: 0, postponed: 0, suspended: 0 };
  const byStatus = { ...statusTpl };
  const byMode = {};
  const byBucket = {};
  const capByBucket = {};
  const trainingsMonthly = {};
  let totalCapacity = 0;
  let totalEnrolled = 0;
  let upcomingCount = 0;
  const upcomingList = [];

  for (const t of trainings) {
    if (t.status in byStatus) byStatus[t.status] += 1;
    else byStatus[t.status] = 1;
    byMode[t.delivery_mode] = (byMode[t.delivery_mode] ?? 0) + 1;
    byBucket[t.bucket] = (byBucket[t.bucket] ?? 0) + 1;
    totalCapacity += t.capacity ?? 0;
    totalEnrolled += t.enrolled_count ?? 0;

    const cb = capByBucket[t.bucket] ?? (capByBucket[t.bucket] = { capacity: 0, enrolled: 0 });
    cb.capacity += t.capacity ?? 0;
    cb.enrolled += t.enrolled_count ?? 0;

    if (t.start_date) {
      const m = String(t.start_date).slice(0, 7);
      trainingsMonthly[m] = (trainingsMonthly[m] ?? 0) + 1;
    }

    const startStr = t.start_date ? String(t.start_date).slice(0, 10) : null;
    const upcoming = startStr && startStr >= todayStr && !["cancelled", "completed"].includes(t.status);
    if (upcoming) {
      upcomingCount += 1;
      if (upcomingList.length < 8) {
        upcomingList.push({
          id: t.id,
          code: t.code,
          title: t.title,
          status: t.status,
          delivery_mode: t.delivery_mode,
          bucket: t.bucket,
          capacity: t.capacity,
          enrolled_count: t.enrolled_count,
          start_date: t.start_date,
          end_date: t.end_date,
          timezone: t.timezone,
          trainer_assigned: t.trainer_name != null,
          trainer_name: t.trainer_name ?? null,
        });
      }
    }
  }

  const es = enrolSummaryRes.rows[0] ?? {};
  const enrolTotal = es.total ?? 0;
  const enrolCompleted = es.completed ?? 0;
  const ss = sessionSummaryRes.rows[0] ?? {};
  const ts0 = trainerSummaryRes.rows[0] ?? {};

  const att = attendanceRes.rows[0] ?? {};
  const attMarked = att.marked ?? 0;
  const attAttended = (att.present ?? 0) + (att.partial ?? 0);
  const attendanceRate = attMarked > 0 ? Math.round((attAttended / attMarked) * 100) / 100 : 0;

  // Cumulative participant growth.
  let running = 0;
  const participantGrowth = participantMonthlyRes.rows.map((r) => {
    running += r.new_count;
    return { month: r.month, new: r.new_count, cumulative: running };
  });

  return {
    generated_at: new Date().toISOString(),
    filters: {
      from: f.from ?? null,
      to: f.to ?? null,
      delivery_mode: f.delivery_mode ?? null,
      bucket: f.bucket ?? null,
      status: f.status ?? null,
      trainer_id: f.trainer_id ?? null,
    },
    summary: {
      trainings_total: trainings.length,
      trainings_upcoming: upcomingCount,
      trainings_ongoing: byStatus.ongoing ?? 0,
      trainings_completed: byStatus.completed ?? 0,
      participants_total: es.participants ?? 0,
      enrolments_total: enrolTotal,
      enrolments_completed: enrolCompleted,
      completion_rate: enrolTotal > 0 ? Math.round((enrolCompleted / enrolTotal) * 100) / 100 : 0,
      total_capacity: totalCapacity,
      total_enrolled: totalEnrolled,
      fill_rate: totalCapacity > 0 ? Math.round((totalEnrolled / totalCapacity) * 100) / 100 : 0,
      trainers_total: ts0.total ?? 0,
      trainers_active: ts0.active ?? 0,
      trainers_assigned: ts0.assigned ?? 0,
      sessions_total: ss.total ?? 0,
      attendance_rate: attendanceRate, // attended (present+partial) / marked, completed trainings
      attendance_marked: attMarked,
      revenue_total: Math.round(es.revenue ?? 0), // paid (confirmed+completed) seats
      currency: "USD",
    },
    enrolments_over_time: enrolMonthlyRes.rows.map((r) => ({
      month: r.month,
      total: r.total,
      confirmed: r.confirmed,
      completed: r.completed,
      cancelled: r.cancelled,
      transferred: r.transferred,
      failed: r.failed,
    })),
    revenue_over_time: enrolMonthlyRes.rows.map((r) => ({
      month: r.month,
      revenue: Math.round(r.revenue ?? 0),
    })),
    participant_growth: participantGrowth,
    trainings_over_time: Object.keys(trainingsMonthly)
      .sort()
      .map((month) => ({ month, count: trainingsMonthly[month] })),
    sessions_over_time: sessionMonthlyRes.rows.map((r) => ({
      month: r.month,
      total: r.total,
      completed: r.completed,
      scheduled: r.scheduled,
    })),
    trainings_by_status: Object.keys(statusTpl).map((status) => ({ status, count: byStatus[status] ?? 0 })),
    trainings_by_delivery_mode: Object.entries(byMode).map(([mode, count]) => ({ mode, count })),
    trainings_by_bucket: Object.entries(byBucket).map(([bucket, count]) => ({ bucket, count })),
    enrolments_by_status: [
      { status: "confirmed", count: es.confirmed ?? 0 },
      { status: "completed", count: es.completed ?? 0 },
      { status: "transferred", count: es.transferred ?? 0 },
      { status: "cancelled", count: es.cancelled ?? 0 },
      { status: "failed", count: es.failed ?? 0 },
    ],
    sessions_by_status: [
      { status: "scheduled", count: ss.scheduled ?? 0 },
      { status: "ongoing", count: ss.ongoing ?? 0 },
      { status: "completed", count: ss.completed ?? 0 },
      { status: "cancelled", count: ss.cancelled ?? 0 },
    ],
    capacity_by_bucket: Object.entries(capByBucket).map(([bucket, v]) => ({
      bucket,
      capacity: v.capacity,
      enrolled: v.enrolled,
    })),
    top_trainers: topTrainersRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      is_active: r.is_active,
      trainings: r.trainings,
      participants: r.participants,
    })),
    course_demand: courseDemandRes.rows.map((r) => ({
      title: r.title,
      requests: r.requests,
      trainings: r.trainings,
      revenue: Math.round(r.revenue ?? 0),
    })),
    revenue_by_course: revenueByCourseRes.rows.map((r) => ({
      title: r.title,
      revenue: Math.round(r.revenue ?? 0),
      requests: r.requests,
    })),
    enrolments_by_tier: tierRes.rows.map((r) => ({
      tier: r.tier,
      enrolments: r.enrolments,
      revenue: Math.round(r.revenue ?? 0),
    })),
    attendance: {
      marked: attMarked,
      present: att.present ?? 0,
      partial: att.partial ?? 0,
      absent: att.absent ?? 0,
      attendance_rate: attendanceRate,
    },
    enrolments_by_duration: durationRes.rows.map((r) => ({
      hours: r.hours,
      label: `${r.hours} hrs/day`,
      trainings: r.trainings,
      enrolments: r.enrolments,
    })),
    enrolments_by_location: locationRes.rows.map((r) => ({
      location: r.location,
      trainings: r.trainings,
      enrolments: r.enrolments,
      revenue: Math.round(r.revenue ?? 0),
    })),
    enrolments_by_sponsorship: sponsorshipRes.rows.map((r) => ({
      sponsorship: r.sponsorship,
      enrolments: r.enrolments,
    })),
    enrolments_by_job_title: jobTitleRes.rows.map((r) => ({
      job_title: r.job_title,
      enrolments: r.enrolments,
    })),
    enrolments_by_department: departmentRes.rows.map((r) => ({
      department: r.department,
      enrolments: r.enrolments,
    })),
    enrolments_by_experience: experienceRes.rows.map((r) => ({
      bracket: r.bracket,
      enrolments: r.enrolments,
    })),
    top_companies: companiesRes.rows.map((r) => ({
      company: r.company,
      enrolments: r.enrolments,
    })),
    upcoming_trainings: upcomingList,
    trainer_options: trainerOptionsRes.rows.map((r) => ({ id: r.id, name: r.name })),
    location_options: locationOptionsRes.rows.map((r) => r.location),
    duration_options: durationOptionsRes.rows.map((r) => r.hours),
    job_title_options: jobTitleOptionsRes.rows.map((r) => r.v),
    department_options: departmentOptionsRes.rows.map((r) => r.v),
  };
}

/* ─────────────────────────────────────────────────────────
   Surveys (pre/post-training feedback forms)
   ───────────────────────────────────────────────────────── */

function publicSurvey(s, responseCount) {
  return {
    id: s.id,
    training_id: s.trainingId,
    type: s.type,
    title: s.title,
    questions: s.questions,
    assigned_at: s.assignedAt,
    ...(responseCount !== undefined ? { response_count: responseCount } : {}),
  };
}

// Create (assign) a survey for a training.
export async function createSurvey(adminId, trainingRef, body, ip) {
  return db.transaction(async (tx) => {
    const training = await resolveTraining(tx, trainingRef);

    const [survey] = await tx
      .insert(surveys)
      .values({
        trainingId: training.id,
        type: body.type,
        title: body.title,
        questions: body.questions,
      })
      .returning();

    await writeAudit(tx, {
      entityType: "survey",
      entityId: survey.id,
      action: "survey_created",
      actorId: adminId,
      after: { training_code: training.code, type: survey.type, title: survey.title },
      ipAddress: ip,
    });

    return publicSurvey(survey);
  });
}

// List a training's surveys, each with its response count.
export async function listTrainingSurveys(trainingRef) {
  const training = await resolveTraining(db, trainingRef);

  const rows = await db
    .select({
      id: surveys.id,
      trainingId: surveys.trainingId,
      type: surveys.type,
      title: surveys.title,
      questions: surveys.questions,
      assignedAt: surveys.assignedAt,
      responseCount: sql`(SELECT count(*)::int FROM survey_responses r WHERE r.survey_id = ${surveys.id})`,
    })
    .from(surveys)
    .where(eq(surveys.trainingId, training.id))
    .orderBy(desc(surveys.assignedAt));

  return { surveys: rows.map((s) => publicSurvey(s, s.responseCount)) };
}

// All responses for a survey (admin analytics).
export async function listSurveyResponses(surveyId) {
  if (!UUID_RE.test(surveyId)) throw new AppError("Survey not found", 404);

  const [survey] = await db.select().from(surveys).where(eq(surveys.id, surveyId)).limit(1);
  if (!survey) throw new AppError("Survey not found", 404);

  const responses = await db
    .select({
      id: surveyResponses.id,
      participantId: participants.id,
      name: participants.name,
      email: participants.email,
      answers: surveyResponses.answers,
      submittedAt: surveyResponses.submittedAt,
    })
    .from(surveyResponses)
    .innerJoin(participants, eq(surveyResponses.participantId, participants.id))
    .where(eq(surveyResponses.surveyId, surveyId))
    .orderBy(desc(surveyResponses.submittedAt));

  return {
    survey: publicSurvey(survey),
    responses: responses.map((r) => ({
      id: r.id,
      participant_id: r.participantId,
      name: r.name,
      email: r.email,
      answers: r.answers,
      submitted_at: r.submittedAt,
    })),
  };
}

/* ─────────────────────────────────────────────────────────
   Attendance matrix (admin view of a training's per-session attendance)
   ───────────────────────────────────────────────────────── */
export async function getTrainingAttendance(trainingRef) {
  const training = await resolveTraining(db, trainingRef);

  const sessions = await db
    .select({
      id: trainingSessions.id,
      dayNumber: trainingSessions.dayNumber,
      startTime: trainingSessions.startTime,
      status: trainingSessions.status,
    })
    .from(trainingSessions)
    .where(eq(trainingSessions.trainingId, training.id))
    .orderBy(trainingSessions.dayNumber);
  const sessionIds = sessions.map((s) => s.id);

  const roster = await db
    .select({
      participantId: participants.id,
      name: participants.name,
      email: participants.email,
      overall: enrolments.attendanceStatus,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(
      and(
        eq(enrolments.trainingId, training.id),
        sql`${enrolments.status} NOT IN ('cancelled', 'transferred')`
      )
    )
    .orderBy(asc(participants.name));

  const recs = sessionIds.length
    ? await db
        .select({
          sessionId: attendanceRecords.sessionId,
          participantId: attendanceRecords.participantId,
          status: attendanceRecords.status,
        })
        .from(attendanceRecords)
        .where(inArray(attendanceRecords.sessionId, sessionIds))
    : [];
  const byKey = new Map(recs.map((r) => [`${r.participantId}:${r.sessionId}`, r.status]));

  return {
    training_id: training.code,
    title: training.title,
    sessions: sessions.map((s) => ({
      id: s.id,
      day_number: s.dayNumber,
      start_time: s.startTime,
      status: s.status,
    })),
    participants: roster.map((p) => {
      const attendance = {};
      let attended = 0;
      for (const s of sessions) {
        const st = byKey.get(`${p.participantId}:${s.id}`) ?? null;
        attendance[s.id] = st;
        if (st === "present" || st === "late") attended += 1;
      }
      return {
        participant_id: p.participantId,
        name: p.name,
        email: p.email,
        overall_status: p.overall,
        attended,
        total_sessions: sessions.length,
        attendance,
      };
    }),
  };
}
