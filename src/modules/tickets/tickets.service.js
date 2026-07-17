import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { tickets, ticketMessages, participants, trainingIds, enrolments, users } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { CATEGORY_PRIORITY, TRAINING_CATEGORIES } from "./tickets.schema.js";

// The login identity → participant (learner) profile. Tickets are scoped to the
// participant, so every learner-facing operation resolves this first.
async function resolveParticipant(runner, userId) {
  const [p] = await runner
    .select()
    .from(participants)
    .where(eq(participants.userId, userId))
    .limit(1);
  if (!p) throw new AppError("No learner profile is linked to this account", 404);
  return p;
}

// Generate TKT-YYYY-NNNN, serialised by an advisory lock so concurrent raises
// can't collide on the code. (Distinct lock key from the training-code generator.)
async function generateTicketCode(tx, year) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(987654322)`);
  const prefix = `TKT-${year}-`;
  const res = await tx.execute(
    sql`SELECT count(*)::int AS n FROM tickets WHERE code LIKE ${prefix + "%"}`
  );
  const next = (res.rows?.[0]?.n ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

const selectCols = {
  id: tickets.id,
  code: tickets.code,
  category: tickets.category,
  priority: tickets.priority,
  status: tickets.status,
  subject: tickets.subject,
  description: tickets.description,
  trainingId: tickets.trainingId,
  trainingCode: trainingIds.code,
  trainingTitle: trainingIds.title,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
  resolvedAt: tickets.resolvedAt,
  messageCount: sql`(SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = ${tickets.id})`,
};

function ticketDto(r) {
  return {
    id: r.id,
    code: r.code,
    category: r.category,
    priority: r.priority,
    status: r.status,
    subject: r.subject,
    description: r.description,
    training: r.trainingId
      ? { id: r.trainingId, code: r.trainingCode, title: r.trainingTitle }
      : null,
    message_count: Number(r.messageCount ?? 0),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    resolved_at: r.resolvedAt,
  };
}

// Full conversation thread for a ticket, oldest first, with author display names.
async function loadMessages(runner, ticketId) {
  const rows = await runner
    .select({
      id: ticketMessages.id,
      authorRole: ticketMessages.authorRole,
      authorName: users.name,
      body: ticketMessages.body,
      createdAt: ticketMessages.createdAt,
    })
    .from(ticketMessages)
    .leftJoin(users, eq(ticketMessages.authorId, users.id))
    .where(eq(ticketMessages.ticketId, ticketId))
    .orderBy(asc(ticketMessages.createdAt));
  return rows.map((m) => ({
    id: m.id,
    author_role: m.authorRole,
    author_name: m.authorName || (m.authorRole === "admin" ? "Support team" : "Learner"),
    body: m.body,
    created_at: m.createdAt,
  }));
}

function summarize(rows) {
  const s = { total: rows.length, open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
  return s;
}

/* ── Learner ──────────────────────────────────────────────── */

export async function createTicket(userId, body, ip) {
  return db.transaction(async (tx) => {
    const participant = await resolveParticipant(tx, userId);
    const { category, subject, description } = body;
    const priority = CATEGORY_PRIORITY[category] || "low";

    let trainingId = null;
    if (TRAINING_CATEGORIES.has(category)) {
      // The referenced training must be one the learner is actually enrolled in.
      const [enr] = await tx
        .select({ trainingId: enrolments.trainingId })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.participantId, participant.id),
            eq(enrolments.trainingId, body.training_id)
          )
        )
        .limit(1);
      if (!enr) throw new AppError("That training isn't in your enrolments", 400);
      trainingId = body.training_id;
    }

    const code = await generateTicketCode(tx, new Date().getFullYear());
    const [created] = await tx
      .insert(tickets)
      .values({
        code,
        participantId: participant.id,
        userId,
        category,
        trainingId,
        subject,
        description,
        priority,
      })
      .returning();

    await writeAudit(tx, {
      entityType: "ticket",
      entityId: created.id,
      action: "ticket_created",
      actorId: userId,
      after: { code, category, priority, training_id: trainingId },
      ipAddress: ip,
    });

    const [row] = await tx
      .select(selectCols)
      .from(tickets)
      .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
      .where(eq(tickets.id, created.id))
      .limit(1);
    return { ticket: ticketDto(row) };
  });
}

export async function listLearnerTickets(userId) {
  const participant = await resolveParticipant(db, userId);
  const rows = await db
    .select(selectCols)
    .from(tickets)
    .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
    .where(eq(tickets.participantId, participant.id))
    .orderBy(desc(tickets.createdAt));
  return { tickets: rows.map(ticketDto), summary: summarize(rows) };
}

export async function getLearnerTicket(userId, id) {
  const participant = await resolveParticipant(db, userId);
  const [row] = await db
    .select(selectCols)
    .from(tickets)
    .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
    .where(and(eq(tickets.id, id), eq(tickets.participantId, participant.id)))
    .limit(1);
  if (!row) throw new AppError("Ticket not found", 404);
  const messages = await loadMessages(db, id);
  return { ticket: { ...ticketDto(row), messages } };
}

// Learner adds a reply to their own ticket's conversation thread.
export async function addLearnerMessage(userId, ticketId, body, ip) {
  const participant = await resolveParticipant(db, userId);
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.participantId, participant.id)))
    .limit(1);
  if (!t) throw new AppError("Ticket not found", 404);
  if (t.status === "closed") throw new AppError("This ticket is closed and can't accept new replies", 400);

  await db.transaction(async (tx) => {
    await tx.insert(ticketMessages).values({ ticketId, authorId: userId, authorRole: "learner", body });
    await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));
    await writeAudit(tx, {
      entityType: "ticket",
      entityId: ticketId,
      action: "ticket_reply",
      actorId: userId,
      after: { role: "learner" },
      ipAddress: ip,
    });
  });
  return getLearnerTicket(userId, ticketId);
}

/* ── Admin ────────────────────────────────────────────────── */

const adminCols = {
  ...selectCols,
  participantId: tickets.participantId,
  learnerName: participants.name,
  learnerEmail: participants.email,
};

function adminTicketDto(r) {
  return {
    ...ticketDto(r),
    learner: { id: r.participantId, name: r.learnerName, email: r.learnerEmail },
  };
}

export async function listAdminTickets({ status, category, search } = {}) {
  const conds = [];
  if (status) conds.push(eq(tickets.status, status));
  if (category) conds.push(eq(tickets.category, category));
  if (search) {
    conds.push(
      or(
        ilike(tickets.code, `%${search}%`),
        ilike(tickets.subject, `%${search}%`),
        ilike(participants.name, `%${search}%`),
        ilike(participants.email, `%${search}%`)
      )
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select(adminCols)
    .from(tickets)
    .innerJoin(participants, eq(tickets.participantId, participants.id))
    .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
    .where(where)
    .orderBy(desc(tickets.createdAt));

  // Summary reflects ALL tickets (not the active filter) so the stat cards stay stable.
  const allRows = await db.select({ status: tickets.status }).from(tickets);
  return { tickets: rows.map(adminTicketDto), summary: summarize(allRows) };
}

export async function getAdminTicket(id) {
  const [row] = await db
    .select(adminCols)
    .from(tickets)
    .innerJoin(participants, eq(tickets.participantId, participants.id))
    .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
    .where(eq(tickets.id, id))
    .limit(1);
  if (!row) throw new AppError("Ticket not found", 404);
  const messages = await loadMessages(db, id);
  return { ticket: { ...adminTicketDto(row), messages } };
}

// Admin adds a reply. A first reply on an 'open' ticket nudges it to
// 'in_progress' (admin is now actively handling it); other statuses are left as-is.
export async function addAdminMessage(adminId, ticketId, body, ip) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) throw new AppError("Ticket not found", 404);

  await db.transaction(async (tx) => {
    await tx.insert(ticketMessages).values({ ticketId, authorId: adminId, authorRole: "admin", body });
    const set = { updatedAt: new Date() };
    if (t.status === "open") set.status = "in_progress";
    await tx.update(tickets).set(set).where(eq(tickets.id, ticketId));
    await writeAudit(tx, {
      entityType: "ticket",
      entityId: ticketId,
      action: "ticket_reply",
      actorId: adminId,
      after: { role: "admin" },
      ipAddress: ip,
    });
  });
  return getAdminTicket(ticketId);
}

export async function updateTicketStatus(adminId, id, body, ip) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    if (!t) throw new AppError("Ticket not found", 404);

    const before = { status: t.status };
    const set = { status: body.status, updatedAt: new Date() };
    if (body.status === "resolved" || body.status === "closed") {
      set.resolvedBy = adminId;
      set.resolvedAt = t.resolvedAt ?? new Date();
    } else {
      set.resolvedBy = null;
      set.resolvedAt = null;
    }
    await tx.update(tickets).set(set).where(eq(tickets.id, id));

    await writeAudit(tx, {
      entityType: "ticket",
      entityId: id,
      action: "ticket_status_updated",
      actorId: adminId,
      before,
      after: { status: body.status },
      ipAddress: ip,
    });

    const [row] = await tx
      .select(adminCols)
      .from(tickets)
      .innerJoin(participants, eq(tickets.participantId, participants.id))
      .leftJoin(trainingIds, eq(tickets.trainingId, trainingIds.id))
      .where(eq(tickets.id, id))
      .limit(1);
    return { ticket: adminTicketDto(row) };
  });
}
