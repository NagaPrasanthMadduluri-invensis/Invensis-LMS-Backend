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
  userProfiles,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { provisionAccountSetup } from "../../lib/account-setup.js";
import { resolveCourseFacts } from "../cms/cms.service.js";

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

// Billing address from the order. Prefer the payment gateway (Stripe) response
// — the CRM's customer.billing block is often empty — falling back to it.
// Returns the camelCase column set, or null when no address is present.
function extractBillingAddress(payload) {
  const stripe = payload.payment?.records?.find(
    (r) => r?.gateway_response?.customer_details?.address
  )?.gateway_response?.customer_details?.address;
  if (stripe) {
    return {
      city: stripe.city ?? null,
      state: stripe.state ?? null,
      country: stripe.country ?? null,
      postalCode: stripe.postal_code ?? null,
      addressLine1: stripe.line1 ?? null,
      addressLine2: stripe.line2 ?? null,
    };
  }
  const b = payload.customer?.billing;
  if (b && (b.city || b.state || b.country || b.postal_code || b.address_line1 || b.address_line2)) {
    return {
      city: b.city ?? null,
      state: b.state ?? null,
      country: b.country ?? null,
      postalCode: b.postal_code ?? null,
      addressLine1: b.address_line1 ?? null,
      addressLine2: b.address_line2 ?? null,
    };
  }
  return null;
}

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
  const learners = payload.learners ?? []; // optional — order may precede learner assignment
  const billing = extractBillingAddress(payload); // buyer's billing address (Stripe / CRM)

  // Resolve CMS course facts (course_type / certification_included) by slug BEFORE
  // opening the transaction, so a slow/down CMS never holds a DB lock or fails the
  // order. Best-effort: falls back to nulls/false when the CMS can't be reached.
  const courseFacts = await resolveCourseFacts(payload.course?.slug);

  // Users created here start with no password; after commit we email each a
  // setup link so they can set one. Collected inside the tx, sent after.
  const toProvision = [];

  const result = await db.transaction(async (tx) => {
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
          hoursPerDay: sch.hours_per_day != null ? Number(sch.hours_per_day) : null,
          capacity: env.SCHEDULE_DEFAULT_CAPACITY,
          minSeats: env.SCHEDULE_DEFAULT_MIN_SEATS,
          startDate: sch.start_date,
          endDate: sch.end_date,
          startTime: sch.start_time,
          endTime: sch.end_time,
          sessionDates: sch.session_dates,
          venue: sch.venue ?? null,
          timezone: sch.timezone ?? sch.timezone_code ?? null,
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
          courseSlug: courseFacts.course_slug,
          courseType: courseFacts.course_type,
          certificationIncluded: courseFacts.certification_included,
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
    for (const l of learners) {
      const name = learnerName(l);

      // Find or create the learner's user account (no password — a setup email
      // is sent after commit so they can set their own).
      let [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, l.email))
        .limit(1);
      if (!user) {
        [user] = await tx
          .insert(users)
          .values({ email: l.email, name, role: "learner" })
          .returning({ id: users.id });
        toProvision.push({ id: user.id, name, email: l.email });
      }

      // Upsert the participant, linked to that user account.
      let [participant] = await tx
        .select()
        .from(participants)
        .where(eq(participants.email, l.email))
        .limit(1);
      if (!participant) {
        [participant] = await tx
          .insert(participants)
          .values({ userId: user.id, name, email: l.email, phone: l.phone ?? null })
          .returning();
      } else if (!participant.userId) {
        await tx
          .update(participants)
          .set({ userId: user.id })
          .where(eq(participants.id, participant.id));
      }

      // Stamp the order's billing address on the participant.
      if (billing) {
        await tx
          .update(participants)
          .set({ ...billing, updatedAt: new Date() })
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

    /* ── 4b. Sponsor (buyer): create/reuse account + link to the order ──
       Runs AFTER learners so a buyer who is also a learner keeps the learner
       role (their sponsor capability comes from the order link, not the role). */
    const buyer = payload.buyer;
    if (buyer?.email) {
      const buyerName =
        buyer.name || `${buyer.first_name ?? ""} ${buyer.last_name ?? ""}`.trim() || buyer.email;

      let [sponsorUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, buyer.email))
        .limit(1);
      if (!sponsorUser) {
        [sponsorUser] = await tx
          .insert(users)
          .values({ email: buyer.email, name: buyerName, role: "sponsor" })
          .returning({ id: users.id });
        toProvision.push({ id: sponsorUser.id, name: buyerName, email: buyer.email });
      }

      // Store the billing address on the sponsor's profile (upsert; the profile
      // row may not exist yet for a freshly-created sponsor).
      if (billing) {
        await tx
          .insert(userProfiles)
          .values({ userId: sponsorUser.id, ...billing })
          .onConflictDoUpdate({
            target: userProfiles.userId,
            set: { ...billing, updatedAt: new Date() },
          });
      }

      await tx
        .update(orders)
        .set({ sponsorUserId: sponsorUser.id, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
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
      participants: learners.length,
      new_enrolments: newEnrolments,
      enrolled_count: cnt.rows?.[0]?.n ?? 0,
      sponsor_email: payload.buyer?.email ?? null,
    };
  });

  // After commit: email each newly-created account a setup link (best-effort).
  for (const u of toProvision) {
    await provisionAccountSetup(u, "setup");
  }

  return result;
}
