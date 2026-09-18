/**
 * Cohort-update notifications — fan an ops action out to the training's learners.
 *
 * Called AFTER the triggering transaction commits (from admin.service), so these
 * read committed state and are best-effort: a mail failure is logged, never
 * thrown, so it can't roll back the action that caused it. Each recipient is
 * sent independently; one bad address doesn't stop the rest.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../config/db.js";
import {
  schedules,
  trainingIds,
  trainerAssignments,
  trainers,
  users,
  enrolments,
  participants,
  orders,
} from "../db/schema.js";

// Aliased users row for the sponsor side of the learner → order → buyer join.
const sponsorUsers = alias(users, "sponsor_users");
import {
  sendJoinLinkEmail,
  sendTrainerAssignedEmail,
  sendCohortRescheduledEmail,
} from "./mailer.js";

const MODE_LABEL = {
  virtual: "Live Virtual Classroom",
  in_person: "In-person Classroom",
  hybrid: "Hybrid",
  one_to_one: "One-to-one Coaching",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtDate = (d) => {
  if (!d) return "TBC";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  if (!y || !m || !day) return String(d);
  return `${Number(day)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
};
const fmtTime = (t) => (t ? String(t).slice(0, 5) : "");

const logFail = (kind, email, err) =>
  console.error(`[cohort-notify:${kind}] ${email ?? ""} ${err?.message ?? err}`);

// Confirmed learners on a training, de-duplicated by email.
async function getEnrolledLearners(trainingId) {
  // Each learner's sponsor = the buyer of their enrolment's order, excluding a
  // self-purchase (sponsor is the same user). Attached as `cc` so info emails
  // keep the sponsor in the loop; null when there's no order or it's self-bought.
  const rows = await db
    .select({ name: participants.name, email: participants.email, cc: sponsorUsers.email })
    .from(enrolments)
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .leftJoin(orders, eq(orders.id, enrolments.orderId))
    .leftJoin(
      sponsorUsers,
      and(eq(sponsorUsers.id, orders.sponsorUserId), ne(sponsorUsers.id, participants.userId))
    )
    .where(and(eq(enrolments.trainingId, trainingId), eq(enrolments.status, "confirmed")));
  const seen = new Set();
  return rows
    .filter((r) => r.email && !seen.has(r.email) && seen.add(r.email))
    .map((r) => ({ name: r.name, email: r.email, cc: r.cc || undefined }));
}

async function trainingCore(trainingId) {
  const [t] = await db
    .select({ code: trainingIds.code, title: trainingIds.title, scheduleId: trainingIds.scheduleId })
    .from(trainingIds)
    .where(eq(trainingIds.id, trainingId))
    .limit(1);
  return t ?? null;
}

// Name of the training's current (unremoved) trainer, or a placeholder.
async function currentTrainerName(trainingId) {
  const [row] = await db
    .select({ name: users.name })
    .from(trainerAssignments)
    .innerJoin(trainers, eq(trainerAssignments.trainerId, trainers.id))
    .innerJoin(users, eq(trainers.userId, users.id))
    .where(and(eq(trainerAssignments.trainingId, trainingId), isNull(trainerAssignments.removedAt)))
    .limit(1);
  return row?.name ?? "To be announced";
}

async function fanOut(kind, trainingId, ctx, send) {
  const learners = await getEnrolledLearners(trainingId);
  for (const l of learners) {
    await send(l, ctx).catch((err) => logFail(kind, l.email, err));
  }
}

/** K1 — join/meeting link released to the cohort. */
export async function notifyJoinLinkReleased(trainingId) {
  try {
    const t = await trainingCore(trainingId);
    if (!t) return;
    const [s] = t.scheduleId
      ? await db.select().from(schedules).where(eq(schedules.id, t.scheduleId)).limit(1)
      : [null];
    const startLine = s
      ? `${fmtDate(s.startDate)}${s.startTime ? ` at ${fmtTime(s.startTime)}` : ""}${s.timezone ? ` ${s.timezone}` : ""}`
      : "TBC";
    const ctx = {
      courseName: t.title,
      batchCode: t.code,
      startLine,
      endDate: s ? fmtDate(s.endDate) : "TBC",
      format: s ? MODE_LABEL[s.deliveryMode] ?? s.deliveryMode : "TBC",
      trainerName: await currentTrainerName(trainingId),
    };
    await fanOut("join-link", trainingId, ctx, sendJoinLinkEmail);
  } catch (err) {
    logFail("join-link", null, err);
  }
}

/** K2 — trainer assigned to the training. */
export async function notifyTrainerAssigned(trainingId) {
  try {
    const t = await trainingCore(trainingId);
    if (!t) return;
    const ctx = {
      courseName: t.title,
      batchCode: t.code,
      trainerName: await currentTrainerName(trainingId),
    };
    await fanOut("trainer-assigned", trainingId, ctx, sendTrainerAssignedEmail);
  } catch (err) {
    logFail("trainer-assigned", null, err);
  }
}

/** K3 — cohort rescheduled. `dates` = { oldStart, oldEnd, newStart, newEnd, reason }. */
export async function notifyCohortRescheduled(trainingId, dates) {
  try {
    const t = await trainingCore(trainingId);
    if (!t) return;
    const ctx = {
      courseName: t.title,
      batchCode: t.code,
      oldStart: fmtDate(dates.oldStart),
      oldEnd: fmtDate(dates.oldEnd),
      newStart: fmtDate(dates.newStart),
      newEnd: fmtDate(dates.newEnd),
      reason: (dates.reason && String(dates.reason).trim()) || "Schedule adjustment",
    };
    await fanOut("reschedule", trainingId, ctx, sendCohortRescheduledEmail);
  } catch (err) {
    logFail("reschedule", null, err);
  }
}
