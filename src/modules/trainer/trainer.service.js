import { and, asc, desc, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  trainingIds,
  trainingSessions,
  trainers,
  trainerAssignments,
  schedules,
  enrolments,
  participants,
  attendanceRecords,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { recomputeEnrolmentAttendance } from "../../lib/attendance.js";

// Assert the JWT user is the trainer currently assigned to `trainingId`.
// Returns the trainer id; throws 403 otherwise. `runner` is a db or tx handle.
async function assertAssigned(runner, userId, trainingId) {
  const [trainer] = await runner
    .select({ id: trainers.id })
    .from(trainers)
    .where(eq(trainers.userId, userId))
    .limit(1);
  if (!trainer) throw new AppError("Trainer profile not found", 403);

  const [assignment] = await runner
    .select({ id: trainerAssignments.id })
    .from(trainerAssignments)
    .where(
      and(
        eq(trainerAssignments.trainingId, trainingId),
        eq(trainerAssignments.trainerId, trainer.id),
        isNull(trainerAssignments.removedAt)
      )
    )
    .limit(1);
  if (!assignment) throw new AppError("You are not assigned to this training", 403);
  return trainer.id;
}

// Accepts either a trainingIds UUID or the human code (e.g. "TRN-2026-0001").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maps the JWT user to their trainer profile id (null if they have none).
async function trainerIdForUser(userId) {
  const [t] = await db
    .select({ id: trainers.id })
    .from(trainers)
    .where(eq(trainers.userId, userId))
    .limit(1);
  return t?.id ?? null;
}

// Trainings currently assigned to the logged-in trainer (derived from the JWT).
export async function listMyTrainings(userId) {
  const trainerId = await trainerIdForUser(userId);
  if (!trainerId) return { trainings: [] };

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
      startDate: schedules.startDate,
      endDate: schedules.endDate,
      timezone: schedules.timezone,
    })
    .from(trainerAssignments)
    .innerJoin(trainingIds, eq(trainerAssignments.trainingId, trainingIds.id))
    .leftJoin(schedules, eq(trainingIds.scheduleId, schedules.id))
    .where(and(eq(trainerAssignments.trainerId, trainerId), isNull(trainerAssignments.removedAt)))
    .orderBy(desc(trainerAssignments.assignedAt));

  return {
    trainings: rows.map((r) => ({
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
    })),
  };
}

// Full detail for one assigned training, incl. sessions (each with its sessionId
// for PATCH /api/trainer/sessions/:sessionId/topics). 403 if not assigned.
export async function getTrainingDetail(userId, trainingRef) {
  const [training] = await db
    .select()
    .from(trainingIds)
    .where(UUID_RE.test(trainingRef) ? eq(trainingIds.id, trainingRef) : eq(trainingIds.code, trainingRef))
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);

  const trainerId = await trainerIdForUser(userId);
  if (!trainerId) throw new AppError("Trainer profile not found", 403);

  const [assignment] = await db
    .select({ id: trainerAssignments.id })
    .from(trainerAssignments)
    .where(
      and(
        eq(trainerAssignments.trainingId, training.id),
        eq(trainerAssignments.trainerId, trainerId),
        isNull(trainerAssignments.removedAt)
      )
    )
    .limit(1);
  if (!assignment) throw new AppError("You are not assigned to this training", 403);

  let schedule = null;
  if (training.scheduleId) {
    [schedule] = await db
      .select({
        startDate: schedules.startDate,
        endDate: schedules.endDate,
        startTime: schedules.startTime,
        endTime: schedules.endTime,
        timezone: schedules.timezone,
        batchType: schedules.batchType,
        venue: schedules.venue,
      })
      .from(schedules)
      .where(eq(schedules.id, training.scheduleId))
      .limit(1);
  }

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

  // Roster for this training. Minimal fields only — a trainer sees who is
  // enrolled and their status, NOT contact details (email/phone) or account state.
  const roster = await db
    .select({
      enrolmentId: enrolments.id,
      participantId: participants.id,
      name: participants.name,
      jobTitle: participants.jobTitle,
      status: enrolments.status,
      enrolledAt: enrolments.enrolledAt,
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(eq(enrolments.trainingId, training.id))
    .orderBy(asc(participants.name));

  return {
    id: training.id,
    training_id: training.code,
    title: training.title,
    delivery_mode: training.deliveryMode,
    bucket: training.bucket,
    status: training.status,
    start_date: schedule?.startDate ?? null,
    end_date: schedule?.endDate ?? null,
    timezone: schedule?.timezone ?? null,
    batch_type: schedule?.batchType ?? null,
    venue: schedule?.venue ?? null,
    sessions: sessions.map((s) => ({
      id: s.id, // sessionId — use with PATCH /api/trainer/sessions/:sessionId/topics
      day_number: s.dayNumber,
      planned_topics: s.plannedTopics,
      start_time: s.startTime,
      end_time: s.endTime,
      status: s.status,
    })),
    participants: roster.map((p) => ({
      enrolment_id: p.enrolmentId,
      participant_id: p.participantId,
      name: p.name,
      job_title: p.jobTitle,
      status: p.status,
      enrolled_at: p.enrolledAt,
    })),
  };
}

export async function updateSessionTopics(userId, sessionId, plannedTopics, ip) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(trainingSessions)
      .where(eq(trainingSessions.id, sessionId))
      .limit(1);
    if (!session) throw new AppError("Session not found", 404);

    // The authenticated user must be the trainer currently assigned to the
    // Training ID that owns this session.
    const [trainer] = await tx
      .select({ id: trainers.id })
      .from(trainers)
      .where(eq(trainers.userId, userId))
      .limit(1);
    if (!trainer) throw new AppError("Trainer profile not found", 403);

    const [assignment] = await tx
      .select({ id: trainerAssignments.id })
      .from(trainerAssignments)
      .where(
        and(
          eq(trainerAssignments.trainingId, session.trainingId),
          eq(trainerAssignments.trainerId, trainer.id),
          isNull(trainerAssignments.removedAt)
        )
      )
      .limit(1);
    if (!assignment) throw new AppError("You are not assigned to this training", 403);

    await tx
      .update(trainingSessions)
      .set({ plannedTopics })
      .where(eq(trainingSessions.id, sessionId));

    await writeAudit(tx, {
      entityType: "training_session",
      entityId: sessionId,
      action: "topics_updated",
      actorId: userId,
      before: { planned_topics: session.plannedTopics },
      after: { planned_topics: plannedTopics },
      ipAddress: ip,
    });

    return {
      id: sessionId,
      day_number: session.dayNumber,
      planned_topics: plannedTopics,
    };
  });
}

/* ─────────────────────────────────────────────────────────
   Attendance — per-session marking by the assigned trainer.
   ───────────────────────────────────────────────────────── */

// Roster for a session with each participant's current attendance (null = unmarked).
export async function getSessionAttendance(userId, sessionId) {
  const [session] = await db
    .select()
    .from(trainingSessions)
    .where(eq(trainingSessions.id, sessionId))
    .limit(1);
  if (!session) throw new AppError("Session not found", 404);
  await assertAssigned(db, userId, session.trainingId);

  const roster = await db
    .select({ participantId: participants.id, name: participants.name, jobTitle: participants.jobTitle })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(
      and(
        eq(enrolments.trainingId, session.trainingId),
        notInArray(enrolments.status, ["cancelled", "transferred"])
      )
    )
    .orderBy(asc(participants.name));

  const recs = await db
    .select({ participantId: attendanceRecords.participantId, status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, sessionId));
  const byParticipant = new Map(recs.map((r) => [r.participantId, r.status]));

  return {
    session: {
      id: session.id,
      day_number: session.dayNumber,
      start_time: session.startTime,
      end_time: session.endTime,
      status: session.status,
    },
    participants: roster.map((p) => ({
      participant_id: p.participantId,
      name: p.name,
      job_title: p.jobTitle,
      status: byParticipant.get(p.participantId) ?? null,
    })),
  };
}

// Bulk upsert attendance for a session, then roll up each enrolment's overall status.
export async function markSessionAttendance(userId, sessionId, records, ip) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(trainingSessions)
      .where(eq(trainingSessions.id, sessionId))
      .limit(1);
    if (!session) throw new AppError("Session not found", 404);
    await assertAssigned(tx, userId, session.trainingId);

    const enrolled = await tx
      .select({ participantId: enrolments.participantId })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.trainingId, session.trainingId),
          notInArray(enrolments.status, ["cancelled", "transferred"])
        )
      );
    const validPids = new Set(enrolled.map((e) => e.participantId));

    for (const rec of records) {
      if (!validPids.has(rec.participant_id)) {
        throw new AppError(`Participant ${rec.participant_id} is not enrolled in this training`, 422);
      }
    }

    for (const rec of records) {
      await tx
        .insert(attendanceRecords)
        .values({ sessionId, participantId: rec.participant_id, status: rec.status, markedBy: userId })
        .onConflictDoUpdate({
          target: [attendanceRecords.sessionId, attendanceRecords.participantId],
          set: { status: rec.status, markedBy: userId, updatedAt: new Date() },
        });
    }

    for (const pid of new Set(records.map((r) => r.participant_id))) {
      await recomputeEnrolmentAttendance(tx, session.trainingId, pid);
    }

    await writeAudit(tx, {
      entityType: "training_session",
      entityId: sessionId,
      action: "attendance_marked",
      actorId: userId,
      after: { count: records.length },
      ipAddress: ip,
    });

    const recs = await tx
      .select({ participantId: attendanceRecords.participantId, status: attendanceRecords.status })
      .from(attendanceRecords)
      .where(eq(attendanceRecords.sessionId, sessionId));

    return {
      session_id: sessionId,
      marked: records.length,
      records: recs.map((r) => ({ participant_id: r.participantId, status: r.status })),
    };
  });
}
