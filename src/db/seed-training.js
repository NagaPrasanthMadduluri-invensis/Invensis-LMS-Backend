import { eq } from "drizzle-orm";
import { db, pool } from "../config/db.js";
import {
  users,
  schedules,
  trainingIds,
  trainingSessions,
  trainers,
  participants,
  enrolments,
} from "./schema.js";

// Demo training graph for verifying the learner/admin/trainer endpoints.
// Idempotent: if the Training ID already exists, it just prints the handles.
const TRAINING_CODE = "TRN-2026-0001";
const START_TIME = "09:00:00";
const END_TIME = "17:00:00";
const SESSION_DATES = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];

async function userByEmail(email) {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!u) throw new Error(`Seed user ${email} not found — run "npm run db:seed" first.`);
  return u;
}

async function printHandles(trainingId) {
  const [training] = await db.select().from(trainingIds).where(eq(trainingIds.id, trainingId)).limit(1);
  const sess = await db.select().from(trainingSessions).where(eq(trainingSessions.trainingId, trainingId)).orderBy(trainingSessions.dayNumber);
  const trainerUser = await userByEmail("trainer@invensis.test");
  const [trainer] = await db.select().from(trainers).where(eq(trainers.userId, trainerUser.id)).limit(1);
  console.log("\n── handles for testing ──");
  console.log("TRAINING_ID =", training.id);
  console.log("SESSION_ID  =", sess[0]?.id);
  console.log("TRAINER_ID  =", trainer?.id);
}

async function seed() {
  const existing = await db.select().from(trainingIds).where(eq(trainingIds.code, TRAINING_CODE)).limit(1);
  if (existing.length > 0) {
    console.log(`Training ${TRAINING_CODE} already exists — reusing.`);
    await printHandles(existing[0].id);
    await pool.end();
    return;
  }

  const admin = await userByEmail("admin@invensis.test");
  const learner = await userByEmail("learner@invensis.test");
  const trainerUser = await userByEmail("trainer@invensis.test");

  // schedule
  const [schedule] = await db
    .insert(schedules)
    .values({
      externalScheduleCode: "INL000006",
      title: "PMP Certification Training",
      bucket: "direct_online",
      deliveryMode: "virtual",
      batchType: "weekday",
      durationHours: 32,
      capacity: 20,
      minSeats: 1,
      startDate: SESSION_DATES[0],
      endDate: SESSION_DATES[SESSION_DATES.length - 1],
      startTime: START_TIME,
      endTime: END_TIME,
      sessionDates: SESSION_DATES,
      timezone: "Asia/Kolkata",
      createdBy: admin.id,
    })
    .returning();

  // training id
  const [training] = await db
    .insert(trainingIds)
    .values({
      scheduleId: schedule.id,
      code: TRAINING_CODE,
      title: schedule.title,
      bucket: schedule.bucket,
      deliveryMode: schedule.deliveryMode,
      status: "active",
      capacity: schedule.capacity,
      minSeats: schedule.minSeats,
      createdBy: admin.id,
    })
    .returning();

  // day-wise sessions from session_dates
  await db.insert(trainingSessions).values(
    SESSION_DATES.map((d, i) => ({
      trainingId: training.id,
      dayNumber: i + 1,
      startTime: new Date(`${d}T${START_TIME}+05:30`),
      endTime: new Date(`${d}T${END_TIME}+05:30`),
    }))
  );

  // trainer profile (so admin can assign)
  await db
    .insert(trainers)
    .values({ userId: trainerUser.id, bio: "PMP-certified trainer", experience: "10 years" })
    .onConflictDoNothing();

  // participant + confirmed enrolment for the learner
  const [participant] = await db
    .insert(participants)
    .values({ userId: learner.id, name: learner.name, email: learner.email })
    .returning();
  await db.insert(enrolments).values({
    trainingId: training.id,
    participantId: participant.id,
    status: "confirmed",
  });

  console.log(`Seeded training ${TRAINING_CODE} with ${SESSION_DATES.length} sessions, 1 trainer, 1 enrolled learner.`);
  await printHandles(training.id);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
