import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../config/db.js";
import { trainingSessions, trainers, trainerAssignments } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";

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
