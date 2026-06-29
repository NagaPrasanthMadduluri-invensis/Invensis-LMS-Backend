import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  trainingIds,
  trainers,
  trainerAssignments,
  enrolments,
  schedules,
  participants,
  users,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { hashPassword } from "../../lib/password.js";
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

      // Min-seat gate on release (unless overridden).
      if (body.meeting_released === true && !training.minSeatsOverride) {
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
    .orderBy(desc(trainingIds.createdAt));

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
      min_seats: r.minSeats,
      start_date: r.startDate,
      end_date: r.endDate,
      duration_hours: r.durationHours,
      timezone: r.timezone,
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
    })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(eq(enrolments.trainingId, training.id))
    .orderBy(desc(enrolments.enrolledAt));

  return {
    id: training.id,
    training_id: training.code,
    title: training.title,
    delivery_mode: training.deliveryMode,
    bucket: training.bucket,
    status: training.status,
    capacity: schedule?.capacity ?? training.capacity,
    min_seats: schedule?.minSeats ?? training.minSeats,
    enrolled_count: training.enrolledCount,
    duration_hours: schedule?.durationHours ?? null,
    batch_type: schedule?.batchType ?? null,
    timezone: schedule?.timezone ?? null,
    start_date: schedule?.startDate ?? null,
    end_date: schedule?.endDate ?? null,
    start_time: schedule?.startTime ?? null,
    end_time: schedule?.endTime ?? null,
    session_dates: schedule?.sessionDates ?? null,
    venue: schedule?.venue ?? null,
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
      status: e.status,
      enrolled_at: e.enrolledAt,
      added_manually: e.orderId == null,
    })),
  };
}

/* ── Active trainers for the assignment picker ── */
export async function listTrainers() {
  const rows = await db
    .select({
      id: trainers.id,
      name: users.name,
      email: users.email,
      bio: trainers.bio,
      experience: trainers.experience,
    })
    .from(trainers)
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(eq(trainers.isActive, true))
    .orderBy(users.name);

  return { trainers: rows };
}

/* ── Manually add a participant + confirmed enrolment to a training ── */
export async function addParticipant(adminId, trainingRef, body, ip) {
  return db.transaction(async (tx) => {
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
      const passwordHash = await hashPassword(env.DEFAULT_PARTICIPANT_PASSWORD);
      [user] = await tx
        .insert(users)
        .values({ email, name, role: "learner", passwordHash })
        .returning({ id: users.id });
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
}
