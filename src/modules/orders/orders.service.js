import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  schedules,
  trainingIds,
  trainingSessions,
  participants,
  enrolments,
  orders,
  users,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";

const DELIVERY_MODE = {
  live_virtual: "virtual",
  virtual: "virtual",
  classroom: "in_person",
  in_person: "in_person",
  hybrid: "hybrid",
  self_paced: "virtual",
  one_to_one: "one_to_one",
};
const BUCKET = {
  individual: "direct_online",
  direct_online: "direct_online",
  corporate: "corporate",
  one_to_one: "one_to_one_coaching",
  one_to_one_coaching: "one_to_one_coaching",
};

const mapDeliveryMode = (f) => DELIVERY_MODE[f] ?? "virtual";
const mapBucket = (p) => BUCKET[p] ?? "direct_online";
const mapBatchType = (b) => (["weekday", "weekend", "combined"].includes(b) ? b : "weekday");
const learnerName = (l) =>
  l.name || `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || l.email;

// Generate TRN-YYYY-NNNN. Serialised by a constant advisory lock so concurrent
// new-training creations (across different schedules) can't collide on the code.
async function generateTrainingCode(tx, year) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(987654321)`);
  const prefix = `TRN-${year}-`;
  const res = await tx.execute(
    sql`SELECT count(*)::int AS n FROM training_ids WHERE code LIKE ${prefix + "%"}`
  );
  const next = (res.rows?.[0]?.n ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export async function ingestOrder(actorId, payload, ip) {
  const paymentStatus = payload.order?.payment_status;
  if (paymentStatus !== "paid") {
    throw new AppError(`Order payment_status is '${paymentStatus}', not 'paid' — not enrolled`, 422);
  }

  const sch = payload.schedule;
  const scheduleCode = sch.schedule_id;

  return db.transaction(async (tx) => {
    // Serialise everything for this schedule (idempotent resolution).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scheduleCode}))`);

    /* ── 1. Schedule (reuse if it already exists) ── */
    let [schedule] = await tx
      .select()
      .from(schedules)
      .where(eq(schedules.externalScheduleCode, scheduleCode))
      .limit(1);

    if (!schedule) {
      [schedule] = await tx
        .insert(schedules)
        .values({
          externalScheduleCode: scheduleCode,
          externalEventId: sch.event_id ?? null,
          externalVariantId: sch.schedule_variant_id ?? null,
          title: payload.course.course_name,
          bucket: mapBucket(payload.order?.purchase_type),
          deliveryMode: mapDeliveryMode(sch.delivery_format),
          batchType: mapBatchType(sch.batch_type),
          durationHours: sch.duration_hours ?? payload.course?.duration_hours ?? null,
          capacity: env.SCHEDULE_DEFAULT_CAPACITY,
          minSeats: env.SCHEDULE_DEFAULT_MIN_SEATS,
          startDate: sch.start_date,
          endDate: sch.end_date,
          startTime: sch.start_time,
          endTime: sch.end_time,
          sessionDates: sch.session_dates,
          venue: sch.venue ?? null,
          timezone: sch.timezone ?? null,
          createdBy: actorId,
        })
        .returning();
    }

    /* ── 2. Resolve Training ID (idempotent) ── */
    let [training] = await tx
      .select()
      .from(trainingIds)
      .where(and(eq(trainingIds.scheduleId, schedule.id), ne(trainingIds.status, "cancelled")))
      .limit(1);

    let trainingCreated = false;
    if (!training) {
      const code = await generateTrainingCode(tx, String(sch.start_date).slice(0, 4));
      [training] = await tx
        .insert(trainingIds)
        .values({
          scheduleId: schedule.id,
          code,
          title: schedule.title,
          bucket: schedule.bucket,
          deliveryMode: schedule.deliveryMode,
          status: "active",
          capacity: schedule.capacity,
          minSeats: schedule.minSeats,
          createdBy: actorId,
        })
        .returning();

      // Day-wise sessions from session_dates (time treated as wall-clock UTC;
      // proper timezone handling via schedule.timezone is a later refinement).
      await tx.insert(trainingSessions).values(
        schedule.sessionDates.map((d, i) => ({
          trainingId: training.id,
          dayNumber: i + 1,
          startTime: new Date(`${d}T${schedule.startTime}Z`),
          endTime: new Date(`${d}T${schedule.endTime}Z`),
        }))
      );
      trainingCreated = true;

      await writeAudit(tx, {
        entityType: "training_id",
        entityId: training.id,
        action: "training_created",
        actorId,
        after: { code: training.code, schedule_code: scheduleCode },
        ipAddress: ip,
      });
    }

    /* ── 3. Order record (idempotent on external_order_id) ── */
    const [order] = await tx
      .insert(orders)
      .values({
        externalOrderId: payload.order_id,
        customerId: payload.customer_id ?? null,
        courseName: payload.course.course_name,
        paymentStatus,
        scheduleId: schedule.id,
        trainingId: training.id,
        payload,
      })
      .onConflictDoUpdate({
        target: orders.externalOrderId,
        set: { paymentStatus, scheduleId: schedule.id, trainingId: training.id, updatedAt: new Date() },
      })
      .returning();

    /* ── 4. Participants + enrolments (idempotent) ── */
    let newEnrolments = 0;
    for (const l of payload.learners) {
      const [linkedUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, l.email))
        .limit(1);

      let [participant] = await tx
        .select()
        .from(participants)
        .where(eq(participants.email, l.email))
        .limit(1);

      if (!participant) {
        [participant] = await tx
          .insert(participants)
          .values({
            userId: linkedUser?.id ?? null,
            name: learnerName(l),
            email: l.email,
            phone: l.phone ?? null,
          })
          .returning();
      } else if (linkedUser && !participant.userId) {
        await tx
          .update(participants)
          .set({ userId: linkedUser.id })
          .where(eq(participants.id, participant.id));
      }

      const inserted = await tx
        .insert(enrolments)
        .values({
          trainingId: training.id,
          participantId: participant.id,
          orderId: order.id,
          status: "confirmed",
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) newEnrolments += 1;
    }

    /* ── 5. Refresh enrolled_count from live rows ── */
    const cnt = await tx.execute(
      sql`SELECT count(*)::int AS n FROM enrolments WHERE training_id = ${training.id} AND status = 'confirmed'`
    );
    await tx
      .update(trainingIds)
      .set({ enrolledCount: cnt.rows?.[0]?.n ?? 0, updatedAt: new Date() })
      .where(eq(trainingIds.id, training.id));

    await writeAudit(tx, {
      entityType: "order",
      entityId: order.id,
      action: "order_ingested",
      actorId,
      after: { order_id: payload.order_id, training_code: training.code, new_enrolments: newEnrolments },
      ipAddress: ip,
    });

    return {
      order_id: payload.order_id,
      schedule_code: scheduleCode,
      training_id: training.id,
      training_code: training.code,
      training_created: trainingCreated,
      participants: payload.learners.length,
      new_enrolments: newEnrolments,
      enrolled_count: cnt.rows?.[0]?.n ?? 0,
    };
  });
}
