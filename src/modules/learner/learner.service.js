import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  trainingIds,
  trainingSessions,
  trainerAssignments,
  trainers,
  participants,
  enrolments,
  users,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

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

export async function getTrainingDetail(userId, trainingId) {
  const [training] = await db
    .select()
    .from(trainingIds)
    .where(eq(trainingIds.id, trainingId))
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);

  // Enrolment guard — the learner must have a confirmed enrolment.
  const enrolled = await db
    .select({ id: enrolments.id })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .where(
      and(
        eq(enrolments.trainingId, trainingId),
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
      and(eq(trainerAssignments.trainingId, trainingId), isNull(trainerAssignments.removedAt))
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
    .where(eq(trainingSessions.trainingId, trainingId))
    .orderBy(trainingSessions.dayNumber);

  const response = {
    training_id: training.code,
    title: training.title,
    delivery_mode: training.deliveryMode,
    bucket: training.bucket,
    status: training.status,
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
