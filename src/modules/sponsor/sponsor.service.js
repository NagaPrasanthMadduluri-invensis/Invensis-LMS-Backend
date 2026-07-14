import { and, desc, eq, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { orders, enrolments, participants, trainingIds } from "../../db/schema.js";

// A sponsor is the buyer of an order (orders.sponsor_user_id). Every query here
// is scoped to the caller's own sponsored orders, so no role gate is needed.

export async function getDashboard(sponsorUserId) {
  const { rows } = await db.execute(sql`
    SELECT
      count(DISTINCT e.participant_id) FILTER (WHERE e.status <> 'transferred')::int AS learners_count,
      count(DISTINCT e.participant_id) FILTER (WHERE e.status = 'confirmed' AND t.status IN ('active', 'ongoing'))::int AS active_count,
      count(DISTINCT o.id)::int AS invoices_count,
      COALESCE(sum(e.amount) FILTER (WHERE o.payment_status <> 'paid'), 0) AS outstanding_amount,
      max(e.currency) AS currency_code
    FROM orders o
    LEFT JOIN enrolments e   ON e.order_id = o.id
    LEFT JOIN training_ids t ON t.id = e.training_id
    WHERE o.sponsor_user_id = ${sponsorUserId}
  `);

  const r = rows[0] ?? {};
  return {
    learners_count: r.learners_count ?? 0,
    active_count: r.active_count ?? 0,
    invoices_count: r.invoices_count ?? 0,
    outstanding_amount: Number(r.outstanding_amount ?? 0),
    currency_code: r.currency_code ?? null,
  };
}

export async function listSponsoredLearners(sponsorUserId) {
  const rows = await db
    .select({
      id: enrolments.id,
      name: participants.name,
      email: participants.email,
      trainingCode: trainingIds.code,
      trainingTitle: trainingIds.title,
      status: enrolments.status,
      enrolledAt: enrolments.enrolledAt,
    })
    .from(enrolments)
    .innerJoin(orders, eq(enrolments.orderId, orders.id))
    .innerJoin(participants, eq(enrolments.participantId, participants.id))
    .innerJoin(trainingIds, eq(enrolments.trainingId, trainingIds.id))
    .where(and(eq(orders.sponsorUserId, sponsorUserId), ne(enrolments.status, "transferred")))
    .orderBy(desc(enrolments.enrolledAt));

  return {
    learners: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      training_code: r.trainingCode,
      training_title: r.trainingTitle,
      status: r.status,
      enrolled_at: r.enrolledAt,
    })),
  };
}

export async function listInvoices(sponsorUserId) {
  const amount = sql`(SELECT sum(e.amount) FROM enrolments e WHERE e.order_id = ${orders.id})`;
  const currency = sql`(SELECT max(e.currency) FROM enrolments e WHERE e.order_id = ${orders.id})`;

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.externalOrderId,
      courseName: orders.courseName,
      status: orders.paymentStatus,
      issuedAt: orders.createdAt,
      amount,
      currency,
    })
    .from(orders)
    .where(eq(orders.sponsorUserId, sponsorUserId))
    .orderBy(desc(orders.createdAt));

  return {
    invoices: rows.map((r) => ({
      id: r.id,
      order_number: r.orderNumber,
      course_name: r.courseName,
      amount: r.amount != null ? Number(r.amount) : null, // null until CRM pricing is populated
      currency_code: r.currency ?? null,
      status: r.status,
      issued_at: r.issuedAt,
      receipt_url: null, // no receipt generation yet
    })),
  };
}
