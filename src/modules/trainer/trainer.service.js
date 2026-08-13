import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
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
  surveys,
  surveyResponses,
  users,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { recomputeEnrolmentAttendance } from "../../lib/attendance.js";
import { storageConfigured, presignPut, presignGet } from "../../lib/storage.js";

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
    .orderBy(asc(schedules.startDate), desc(trainerAssignments.assignedAt)); // by training date, ascending (nulls last)

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

/* ─────────────────────────────────────────────────────────
   Feedback — post-training survey results for the trainer's own trainings.
   Averages + anonymous individual entries (no participant identity).
   ───────────────────────────────────────────────────────── */

const avg = (nums) =>
  nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
const numeric = (answers, key) => avg(answers.map((a) => a?.[key]).filter((v) => typeof v === "number"));

// One row per assigned training: response count + average trainer rating.
export async function listFeedback(userId) {
  const trainerId = await trainerIdForUser(userId);
  if (!trainerId) return { trainings: [] };

  const trainings = await db
    .select({ id: trainingIds.id, code: trainingIds.code, title: trainingIds.title })
    .from(trainerAssignments)
    .innerJoin(trainingIds, eq(trainerAssignments.trainingId, trainingIds.id))
    .where(and(eq(trainerAssignments.trainerId, trainerId), isNull(trainerAssignments.removedAt)))
    .orderBy(asc(trainingIds.code));
  if (trainings.length === 0) return { trainings: [] };

  const responses = await db
    .select({ trainingId: surveys.trainingId, answers: surveyResponses.answers })
    .from(surveyResponses)
    .innerJoin(surveys, eq(surveyResponses.surveyId, surveys.id))
    .where(
      and(
        inArray(surveys.trainingId, trainings.map((t) => t.id)),
        eq(surveys.type, "post_training")
      )
    );

  const byTraining = new Map();
  for (const r of responses) {
    if (!byTraining.has(r.trainingId)) byTraining.set(r.trainingId, []);
    byTraining.get(r.trainingId).push(r.answers);
  }

  return {
    trainings: trainings.map((t) => {
      const ans = byTraining.get(t.id) ?? [];
      return {
        id: t.id,
        code: t.code,
        title: t.title,
        response_count: ans.length,
        avg_trainer_rating: numeric(ans, "trainer_rating"),
      };
    }),
  };
}

// Per-training feedback detail: averages + anonymous individual entries.
export async function getTrainingFeedback(userId, trainingRef) {
  const [training] = await db
    .select()
    .from(trainingIds)
    .where(UUID_RE.test(trainingRef) ? eq(trainingIds.id, trainingRef) : eq(trainingIds.code, trainingRef))
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);
  await assertAssigned(db, userId, training.id);

  const rows = await db
    .select({ answers: surveyResponses.answers, submittedAt: surveyResponses.submittedAt })
    .from(surveyResponses)
    .innerJoin(surveys, eq(surveyResponses.surveyId, surveys.id))
    .where(and(eq(surveys.trainingId, training.id), eq(surveys.type, "post_training")))
    .orderBy(desc(surveyResponses.submittedAt));

  const answers = rows.map((r) => r.answers);
  const recommend = answers.map((a) => a?.would_recommend).filter((v) => typeof v === "boolean");

  return {
    training_id: training.code,
    title: training.title,
    response_count: answers.length,
    averages: {
      trainer_rating: numeric(answers, "trainer_rating"),
      overall_rating: numeric(answers, "overall_rating"),
      content_rating: numeric(answers, "content_rating"),
      would_recommend_pct: recommend.length
        ? Math.round((recommend.filter(Boolean).length / recommend.length) * 100)
        : null,
    },
    // Anonymous — no participant identity is exposed to the trainer.
    responses: rows.map((r) => ({
      overall_rating: r.answers?.overall_rating ?? null,
      trainer_rating: r.answers?.trainer_rating ?? null,
      content_rating: r.answers?.content_rating ?? null,
      would_recommend: typeof r.answers?.would_recommend === "boolean" ? r.answers.would_recommend : null,
      comments: r.answers?.comments ?? null,
      submitted_at: r.submittedAt,
    })),
  };
}

/* ─────────────────────────────────────────────────────────
   Trainer self-service profile (GET / PATCH / resume upload)
   ───────────────────────────────────────────────────────── */

function formatTrainerLocation({ city, country, isRemote }) {
  const place = [city, country].filter(Boolean).join(", ");
  if (isRemote) return place ? `${place} · Remote` : "Remote";
  return place || null;
}

// Shape the trainer's own profile for the trainer portal. `resume_url` is a
// short-lived presigned GET URL (null when no resume or storage unconfigured).
async function publicTrainerProfile(t, u) {
  return {
    id: t.id,
    user_id: t.userId,
    name: u.name,
    email: u.email,
    bio: t.bio,
    experience: t.experience,
    rate: t.rate,
    certificates: t.certificates ?? [],
    specializations: t.specializations ?? [],
    city: t.city ?? null,
    country: t.country ?? null,
    is_remote: t.isRemote ?? false,
    location: formatTrainerLocation({ city: t.city, country: t.country, isRemote: t.isRemote }),
    resume_key: t.resumeKey ?? null,
    resume_url: t.resumeKey ? await presignGet(t.resumeKey) : null,
    is_active: t.isActive,
  };
}

async function loadOwnTrainer(runner, userId) {
  const [row] = await runner
    .select({ t: trainers, u: users })
    .from(trainers)
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(eq(trainers.userId, userId))
    .limit(1);
  if (!row) throw new AppError("Trainer profile not found", 404);
  return row;
}

export async function getMyProfile(userId) {
  const row = await loadOwnTrainer(db, userId);
  return { trainer: await publicTrainerProfile(row.t, row.u) };
}

export async function updateMyProfile(userId, body, ip) {
  const trainer = await db.transaction(async (tx) => {
    const { t, u } = await loadOwnTrainer(tx, userId);

    const before = {
      bio: t.bio,
      experience: t.experience,
      certificates: t.certificates,
      specializations: t.specializations,
      city: t.city,
      country: t.country,
      is_remote: t.isRemote,
      resume_key: t.resumeKey,
    };

    const set = { updatedAt: new Date() };
    if (body.bio !== undefined) set.bio = body.bio;
    if (body.experience !== undefined) set.experience = body.experience;
    if (body.certificates !== undefined) set.certificates = body.certificates;
    if (body.specializations !== undefined) set.specializations = body.specializations;
    if (body.city !== undefined) set.city = body.city;
    if (body.country !== undefined) set.country = body.country;
    if (body.is_remote !== undefined) set.isRemote = body.is_remote;
    if (body.resume_key !== undefined) set.resumeKey = body.resume_key;
    await tx.update(trainers).set(set).where(eq(trainers.id, t.id));

    // Display name lives on the user account.
    if (body.name !== undefined) {
      await tx.update(users).set({ name: body.name, updatedAt: new Date() }).where(eq(users.id, u.id));
    }

    await writeAudit(tx, {
      entityType: "trainer",
      entityId: t.id,
      action: "trainer_self_updated",
      actorId: u.id,
      before,
      after: { ...set, ...(body.name !== undefined ? { name: body.name } : {}) },
      ipAddress: ip,
    });

    return loadOwnTrainer(tx, userId);
  });

  return { trainer: await publicTrainerProfile(trainer.t, trainer.u) };
}

// Presigned PUT for a resume PDF, straight to R2 (the API never sees the bytes).
// Size is capped on the client (see RESUME_MAX_BYTES there); we pin the object
// key + content type here.
export async function createResumeUploadUrl(userId, contentType) {
  if (!storageConfigured()) {
    throw new AppError("File storage is not configured", 503);
  }
  // Ensure the caller actually has a trainer profile before minting a URL.
  const { t } = await loadOwnTrainer(db, userId);
  const key = `resumes/${t.id}/${randomUUID()}.pdf`;
  const uploadUrl = await presignPut(key, contentType);
  return {
    upload_url: uploadUrl,
    resume_key: key,
    method: "PUT",
    headers: { "Content-Type": contentType },
    expires_in: 300,
    // After a successful PUT, PATCH /trainer/profile with { "resume_key": <this> }.
  };
}
