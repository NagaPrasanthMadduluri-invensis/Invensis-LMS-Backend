import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { trainingIds, trainers, trainerAssignments, enrolments } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { enqueueMeetingLinkRelease } from "../../lib/queue.js";

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

export async function updateTraining(adminId, trainingId, body, ip) {
  return db.transaction(async (tx) => {
    const [training] = await tx
      .select()
      .from(trainingIds)
      .where(eq(trainingIds.id, trainingId))
      .limit(1);
    if (!training) throw new AppError("Training not found", 404);

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
