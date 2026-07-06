import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  trainingIds,
  trainingSessions,
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
import { provisionAccountSetup } from "../../lib/account-setup.js";
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

export async function getTrainerDetail(trainerId) {
  const [row] = await db
    .select({ t: trainers, u: users })
    .from(trainers)
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(eq(trainers.id, trainerId))
    .limit(1);
  if (!row) throw new AppError("Trainer not found", 404);

  const history = await db
    .select({
      trainingId: trainerAssignments.trainingId,
      code: trainingIds.code,
      title: trainingIds.title,
      assignedAt: trainerAssignments.assignedAt,
      removedAt: trainerAssignments.removedAt,
    })
    .from(trainerAssignments)
    .innerJoin(trainingIds, eq(trainerAssignments.trainingId, trainingIds.id))
    .where(eq(trainerAssignments.trainerId, trainerId))
    .orderBy(desc(trainerAssignments.assignedAt));

  return {
    ...publicTrainer(row.t, row.u),
    assignments: history.map((a) => ({
      training_id: a.trainingId,
      code: a.code,
      title: a.title,
      assigned_at: a.assignedAt,
      removed_at: a.removedAt,
      active: a.removedAt == null,
    })),
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
      is_active: trainer.isActive,
    };

    const set = { updatedAt: new Date() };
    if (body.bio !== undefined) set.bio = body.bio;
    if (body.experience !== undefined) set.experience = body.experience;
    if (body.rate !== undefined) set.rate = body.rate != null ? String(body.rate) : null;
    if (body.certificates !== undefined) set.certificates = body.certificates;
    if (body.is_active !== undefined) set.isActive = body.is_active;
    await tx.update(trainers).set(set).where(eq(trainers.id, trainerId));

    if (body.name !== undefined) {
      await tx
        .update(users)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(users.id, trainer.userId));
    }

    await writeAudit(tx, {
      entityType: "trainer",
      entityId: trainerId,
      action: "trainer_updated",
      actorId: adminId,
      before,
      after: { ...set, name: body.name },
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
