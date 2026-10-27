import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../../config/db.js";
import { webinars } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";

// A webinar leaves the banner 6 hours before it starts.
const LEAD_HOURS = 6;

function dto(r) {
  return {
    id: r.id,
    title: r.title,
    speaker: r.speaker ?? null,
    start_at: r.startAt,
    end_at: r.endAt,
    timezone: r.timezone,
    register_url: r.registerUrl,
    is_active: r.isActive,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function toRow(body) {
  const row = {};
  if (body.title !== undefined) row.title = body.title;
  if (body.speaker !== undefined) row.speaker = body.speaker || null;
  if (body.start_at !== undefined) row.startAt = new Date(body.start_at);
  if (body.end_at !== undefined) row.endAt = new Date(body.end_at);
  if (body.timezone !== undefined) row.timezone = body.timezone;
  if (body.register_url !== undefined) row.registerUrl = body.register_url;
  if (body.is_active !== undefined) row.isActive = body.is_active;
  return row;
}

// Admin: all webinars, soonest-start first among upcoming, then past.
export async function listWebinars() {
  const rows = await db.select().from(webinars).orderBy(desc(webinars.startAt));
  return { webinars: rows.map(dto) };
}

// The one the banner shows: active, starting more than LEAD_HOURS from now,
// soonest first. Returns null when there's nothing to show.
export async function getCurrentWebinar() {
  const [row] = await db
    .select()
    .from(webinars)
    .where(
      and(
        eq(webinars.isActive, true),
        gt(webinars.startAt, sql`now() + (${LEAD_HOURS} * interval '1 hour')`)
      )
    )
    .orderBy(asc(webinars.startAt))
    .limit(1);
  return { webinar: row ? dto(row) : null };
}

export async function createWebinar(adminId, body, ip) {
  const [row] = await db
    .insert(webinars)
    .values({ ...toRow(body), createdBy: adminId })
    .returning();
  await writeAudit(db, {
    entityType: "webinar",
    entityId: row.id,
    action: "webinar_created",
    actorId: adminId,
    after: dto(row),
    ipAddress: ip,
  });
  return { webinar: dto(row) };
}

export async function updateWebinar(adminId, id, body, ip) {
  const [existing] = await db.select().from(webinars).where(eq(webinars.id, id)).limit(1);
  if (!existing) throw new AppError("Webinar not found", 404);
  const [row] = await db
    .update(webinars)
    .set({ ...toRow(body), updatedAt: new Date() })
    .where(eq(webinars.id, id))
    .returning();
  await writeAudit(db, {
    entityType: "webinar",
    entityId: id,
    action: "webinar_updated",
    actorId: adminId,
    before: dto(existing),
    after: dto(row),
    ipAddress: ip,
  });
  return { webinar: dto(row) };
}

export async function deleteWebinar(adminId, id, ip) {
  const [existing] = await db.select().from(webinars).where(eq(webinars.id, id)).limit(1);
  if (!existing) throw new AppError("Webinar not found", 404);
  await db.delete(webinars).where(eq(webinars.id, id));
  await writeAudit(db, {
    entityType: "webinar",
    entityId: id,
    action: "webinar_deleted",
    actorId: adminId,
    before: dto(existing),
    ipAddress: ip,
  });
  return { ok: true };
}
