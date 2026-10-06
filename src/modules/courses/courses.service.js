import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../config/db.js";
import {
  courses,
  courseResources,
  trainingIds,
  enrolments,
  participants,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import {
  storageConfigured,
  presignPut,
  presignGet,
  deleteObject,
} from "../../lib/storage.js";
import { listCourses as cmsListCourses } from "../cms/cms.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map a CMS content extension / resource type onto our coarse enum.
const RESOURCE_TYPES = new Set(["video", "pdf", "zip", "word", "excel", "ppt", "image", "link", "other"]);
const EXT_TYPE = {
  pdf: "pdf",
  zip: "zip", rar: "zip", "7z": "zip",
  doc: "word", docx: "word",
  xls: "excel", xlsx: "excel", csv: "excel",
  ppt: "ppt", pptx: "ppt",
  mp4: "video", mov: "video", avi: "video", mkv: "video", webm: "video",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
};

function inferResourceType(fileName = "") {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return EXT_TYPE[ext] || "other";
}

function normalizeType(type, fileName) {
  if (type && RESOURCE_TYPES.has(type)) return type;
  return inferResourceType(fileName);
}

/* ─────────────────────────────────────────────────────────
   Course catalogue (local mirror of the CMS)
   ───────────────────────────────────────────────────────── */

function publicCourse(c) {
  return {
    id: c.id,
    cms_id: c.cmsId ?? null,
    slug: c.slug,
    name: c.name,
    short_name: c.shortName ?? null,
    description: c.description ?? null,
    course_type: c.courseType ?? null,
    certification_included: c.certificationIncluded ?? false,
    duration_hours: c.durationHours ?? null,
    category: c.categoryName ? { name: c.categoryName, slug: c.categorySlug ?? null } : null,
    icon_url: c.iconUrl ?? null,
    banner_image_url: c.bannerImageUrl ?? null,
    is_active: c.isActive ?? true,
    last_synced_at: c.lastSyncedAt ?? null,
  };
}

// The full catalogue we hold locally, newest sync first, name-ordered.
export async function listLocalCourses() {
  const rows = await db.select().from(courses).orderBy(asc(courses.name));
  return { courses: rows.map(publicCourse) };
}

// Resolve a course by UUID or slug; throws 404.
async function resolveCourse(ref) {
  const [c] = await db
    .select()
    .from(courses)
    .where(UUID_RE.test(ref) ? eq(courses.id, ref) : eq(courses.slug, ref))
    .limit(1);
  if (!c) throw new AppError("Course not found", 404);
  return c;
}

export async function getCourse(ref) {
  return { course: publicCourse(await resolveCourse(ref)) };
}

/**
 * Create a locally-defined course — one that arrives via CRM orders but isn't in
 * the CMS. Stored with no cms_id / last_synced_at so it's distinguishable from a
 * synced course. Certificates and learner views join live by slug, so defining a
 * course here makes course_type / catalogue info appear on existing trainings and
 * certificates for that slug immediately — no backfill needed.
 *
 * If the slug later appears in a CMS sync, the CMS values overwrite these
 * (CMS remains the source of truth).
 */
export async function createCourse(body, userId, ip) {
  const values = {
    slug: body.slug,
    name: body.name,
    shortName: body.short_name ?? null,
    description: body.description ?? null,
    courseType: body.course_type ?? null,
    certificationIncluded: body.certification_included ?? false,
    durationHours: body.duration_hours ?? null,
    categoryName: body.category_name ?? null,
    categorySlug: body.category_slug ?? null,
    iconUrl: body.icon_url ?? null,
    bannerImageUrl: body.banner_image_url ?? null,
    isActive: body.is_active ?? true,
    cmsId: null, // locally defined — not from the CMS
    lastSyncedAt: null,
  };

  let row;
  try {
    [row] = await db.insert(courses).values(values).returning();
  } catch (e) {
    // Unique violation on the slug — the course (CMS or local) already exists.
    if (e?.code === "23505") {
      throw new AppError("A course with this slug already exists", 409);
    }
    throw e;
  }

  await writeAudit(db, {
    entityType: "course",
    entityId: row.id,
    action: "create",
    actorId: userId,
    after: { slug: row.slug, name: row.name, source: "manual" },
    ipAddress: ip,
  });

  return { course: publicCourse(row) };
}

/**
 * Update a course's metadata (duration, category, course_type, certification,
 * activation, etc.). `slug` is immutable — it's the join key everything links by.
 * Works on any course row (CMS-synced or locally defined); note a later CMS sync
 * will overwrite fields for a synced slug.
 */
export async function updateCourse(ref, body, userId, ip) {
  const existing = await resolveCourse(ref); // 404s if not found

  const set = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.short_name !== undefined) set.shortName = body.short_name;
  if (body.description !== undefined) set.description = body.description;
  if (body.course_type !== undefined) set.courseType = body.course_type;
  if (body.certification_included !== undefined) set.certificationIncluded = body.certification_included;
  if (body.duration_hours !== undefined) set.durationHours = body.duration_hours;
  if (body.category_name !== undefined) set.categoryName = body.category_name;
  if (body.category_slug !== undefined) set.categorySlug = body.category_slug;
  if (body.icon_url !== undefined) set.iconUrl = body.icon_url;
  if (body.banner_image_url !== undefined) set.bannerImageUrl = body.banner_image_url;
  if (body.is_active !== undefined) set.isActive = body.is_active;

  const [row] = await db
    .update(courses)
    .set(set)
    .where(eq(courses.id, existing.id))
    .returning();

  await writeAudit(db, {
    entityType: "course",
    entityId: existing.id,
    action: "update",
    actorId: userId,
    before: {
      name: existing.name,
      course_type: existing.courseType,
      certification_included: existing.certificationIncluded,
      duration_hours: existing.durationHours,
      is_active: existing.isActive,
    },
    after: {
      name: row.name,
      course_type: row.courseType,
      certification_included: row.certificationIncluded,
      duration_hours: row.durationHours,
      is_active: row.isActive,
    },
    ipAddress: ip,
  });

  return { course: publicCourse(row) };
}

/**
 * Pull the course catalogue from the CMS and upsert every course by slug.
 * Additive/idempotent — existing resources are untouched. Returns a summary.
 */
export async function syncCoursesFromCms(userId, ip) {
  const seen = [];
  const perPage = 100;
  const maxPages = 50; // safety cap
  let page = 1;

  // The CMS may paginate; follow meta.last_page when present, else stop when a
  // page returns fewer than perPage rows.
  while (page <= maxPages) {
    const { courses: batch, meta } = await cmsListCourses({ page, per_page: perPage });
    if (!batch.length) break;
    seen.push(...batch);
    const lastPage = meta?.last_page ?? meta?.total_pages ?? null;
    if (lastPage != null) {
      if (page >= lastPage) break;
    } else if (batch.length < perPage) {
      break;
    }
    page += 1;
  }

  // Upsert each course keyed by slug. Skip entries with no slug (can't key them).
  let created = 0;
  let updated = 0;
  const now = new Date();
  for (const c of seen) {
    if (!c.slug) continue;
    const values = {
      cmsId: c.id != null ? String(c.id) : null,
      slug: c.slug,
      name: c.name || c.slug,
      shortName: c.short_name ?? null,
      description: c.description ?? null,
      courseType: c.course_type ?? null,
      certificationIncluded: !!c.certification_included,
      durationHours: c.duration_hours ?? null,
      categoryName: c.category?.name ?? null,
      categorySlug: c.category?.slug ?? null,
      iconUrl: c.icon_url ?? null,
      bannerImageUrl: c.banner_image_url ?? null,
      isActive: true,
      lastSyncedAt: now,
      updatedAt: now,
    };
    const res = await db
      .insert(courses)
      .values(values)
      .onConflictDoUpdate({ target: courses.slug, set: values })
      .returning({ id: courses.id, createdAt: courses.createdAt });
    // A fresh insert has createdAt === now (within this sync); an update keeps
    // the original. Cheap heuristic for the summary counts.
    if (res[0] && Math.abs(new Date(res[0].createdAt).getTime() - now.getTime()) < 5000) created += 1;
    else updated += 1;
  }

  await writeAudit(db, {
    entityType: "course",
    entityId: randomUUID(),
    action: "cms_sync",
    actorId: userId,
    after: { fetched: seen.length, created, updated },
    ipAddress: ip,
  });

  return { synced: seen.length, created, updated, at: now.toISOString() };
}

/* ─────────────────────────────────────────────────────────
   Resources — shared shaping
   ───────────────────────────────────────────────────────── */

// Shape a resource row for the API, embedding a short-lived download URL for
// R2-hosted files (external links carry their own url).
async function publicResource(r) {
  const isLink = !!r.externalUrl;
  const url = isLink ? r.externalUrl : await presignGet(r.storageKey, 3600);
  return {
    id: r.id,
    course_id: r.courseId ?? null,
    training_id: r.trainingId ?? null,
    kind: r.kind,
    title: r.title,
    description: r.description ?? null,
    type: r.resourceType,
    file_name: r.fileName ?? null,
    file_size: r.fileSize ?? null,
    content_type: r.contentType ?? null,
    is_link: isLink,
    external_url: r.externalUrl ?? null,
    url, // download_url for files, external_url for links (null if storage down)
    is_active: r.isActive,
    created_at: r.createdAt,
  };
}

async function shapeMany(rows) {
  return Promise.all(rows.map(publicResource));
}

/* ─────────────────────────────────────────────────────────
   Predefined resources (per course)
   ───────────────────────────────────────────────────────── */

export async function listCourseResources(courseRef, { activeOnly = false } = {}) {
  const course = await resolveCourse(courseRef);
  const conds = [eq(courseResources.courseId, course.id), eq(courseResources.kind, "predefined")];
  if (activeOnly) conds.push(eq(courseResources.isActive, true));
  const rows = await db
    .select()
    .from(courseResources)
    .where(and(...conds))
    .orderBy(desc(courseResources.createdAt));
  return { course: publicCourse(course), resources: await shapeMany(rows) };
}

// Mint a presigned PUT so the browser uploads a predefined file straight to R2.
export async function createCourseResourceUploadUrl(courseRef, { fileName, contentType }) {
  if (!storageConfigured()) throw new AppError("File storage is not configured", 503);
  const course = await resolveCourse(courseRef);
  const safeName = (fileName || "file").replace(/[^\w.\-]+/g, "_");
  const key = `course-resources/${course.id}/${randomUUID()}-${safeName}`;
  const uploadUrl = await presignPut(key, contentType || "application/octet-stream");
  return {
    upload_url: uploadUrl,
    storage_key: key,
    method: "PUT",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    expires_in: 300,
  };
}

// Persist a predefined resource row (after the browser's PUT, or for a link).
export async function createCourseResource(courseRef, body, userId, ip) {
  const course = await resolveCourse(courseRef);
  return createResourceRow(
    { courseId: course.id, trainingId: null, kind: "predefined" },
    body, userId, ip
  );
}

/* ─────────────────────────────────────────────────────────
   Supplementary resources (per training run)
   ───────────────────────────────────────────────────────── */

async function resolveTraining(ref) {
  const [t] = await db
    .select({ id: trainingIds.id, code: trainingIds.code })
    .from(trainingIds)
    .where(UUID_RE.test(ref) ? eq(trainingIds.id, ref) : eq(trainingIds.code, ref))
    .limit(1);
  if (!t) throw new AppError("Training not found", 404);
  return t;
}

export async function listTrainingResources(trainingRef, { activeOnly = false } = {}) {
  const training = await resolveTraining(trainingRef);
  const conds = [eq(courseResources.trainingId, training.id), eq(courseResources.kind, "supplementary")];
  if (activeOnly) conds.push(eq(courseResources.isActive, true));
  const rows = await db
    .select()
    .from(courseResources)
    .where(and(...conds))
    .orderBy(desc(courseResources.createdAt));
  return { training, resources: await shapeMany(rows) };
}

export async function createTrainingResourceUploadUrl(trainingRef, { fileName, contentType }) {
  if (!storageConfigured()) throw new AppError("File storage is not configured", 503);
  const training = await resolveTraining(trainingRef);
  const safeName = (fileName || "file").replace(/[^\w.\-]+/g, "_");
  const key = `training-resources/${training.id}/${randomUUID()}-${safeName}`;
  const uploadUrl = await presignPut(key, contentType || "application/octet-stream");
  return {
    upload_url: uploadUrl,
    storage_key: key,
    method: "PUT",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    expires_in: 300,
  };
}

export async function createTrainingResource(trainingRef, body, userId, ip) {
  const training = await resolveTraining(trainingRef);
  return createResourceRow(
    { courseId: null, trainingId: training.id, kind: "supplementary" },
    body, userId, ip
  );
}

/* ─────────────────────────────────────────────────────────
   Resource create / update / delete (shared)
   ───────────────────────────────────────────────────────── */

async function createResourceRow(anchor, body, userId, ip) {
  const isLink = body.type === "link" || (!!body.external_url && !body.storage_key);
  if (isLink) {
    if (!body.external_url) throw new AppError("A URL is required for a link resource", 422);
  } else if (!body.storage_key) {
    throw new AppError("Upload the file before saving (storage_key missing)", 422);
  }

  const [row] = await db
    .insert(courseResources)
    .values({
      ...anchor,
      title: body.title,
      description: body.description ?? null,
      resourceType: isLink ? "link" : normalizeType(body.type, body.file_name),
      storageKey: isLink ? null : body.storage_key,
      fileName: isLink ? null : body.file_name ?? null,
      fileSize: isLink ? null : body.file_size ?? null,
      contentType: isLink ? null : body.content_type ?? null,
      externalUrl: isLink ? body.external_url : null,
      isActive: body.is_active ?? true,
      uploadedBy: userId,
    })
    .returning();

  await writeAudit(db, {
    entityType: "course_resource",
    entityId: row.id,
    action: "create",
    actorId: userId,
    after: { title: row.title, kind: row.kind, type: row.resourceType },
    ipAddress: ip,
  });

  return { resource: await publicResource(row) };
}

export async function updateResource(resourceId, body, userId, ip) {
  const [existing] = await db
    .select()
    .from(courseResources)
    .where(eq(courseResources.id, resourceId))
    .limit(1);
  if (!existing) throw new AppError("Resource not found", 404);

  const set = { updatedAt: new Date() };
  if (body.title !== undefined) set.title = body.title;
  if (body.description !== undefined) set.description = body.description;
  if (body.is_active !== undefined) set.isActive = body.is_active;
  // Metadata-only edits; the file/link itself isn't swapped here (delete + re-add).
  if (body.external_url !== undefined && existing.externalUrl) set.externalUrl = body.external_url;

  const [row] = await db
    .update(courseResources)
    .set(set)
    .where(eq(courseResources.id, resourceId))
    .returning();

  await writeAudit(db, {
    entityType: "course_resource",
    entityId: resourceId,
    action: "update",
    actorId: userId,
    before: { title: existing.title, is_active: existing.isActive },
    after: { title: row.title, is_active: row.isActive },
    ipAddress: ip,
  });

  return { resource: await publicResource(row) };
}

export async function deleteResource(resourceId, userId, ip) {
  const [existing] = await db
    .select()
    .from(courseResources)
    .where(eq(courseResources.id, resourceId))
    .limit(1);
  if (!existing) throw new AppError("Resource not found", 404);

  await db.delete(courseResources).where(eq(courseResources.id, resourceId));

  // Best-effort R2 cleanup — a storage failure shouldn't leave a dangling row.
  if (existing.storageKey) {
    try { await deleteObject(existing.storageKey); } catch { /* logged upstream */ }
  }

  await writeAudit(db, {
    entityType: "course_resource",
    entityId: resourceId,
    action: "delete",
    actorId: userId,
    before: { title: existing.title, kind: existing.kind },
    ipAddress: ip,
  });

  return { deleted: true };
}

/* ─────────────────────────────────────────────────────────
   Enrolled-learner / trainer read
   ───────────────────────────────────────────────────────── */

// Resources visible to someone attending a training: the course's predefined
// courseware plus this run's supplementary material. `userId` must be enrolled
// (as a participant) OR an admin/trainer — enforced by the caller's route guard;
// here we additionally verify participant enrolment when `requireEnrolment`.
export async function listResourcesForTraining(trainingRef, { userId, requireEnrolment } = {}) {
  const [training] = await db
    .select({ id: trainingIds.id, code: trainingIds.code, courseSlug: trainingIds.courseSlug })
    .from(trainingIds)
    .where(UUID_RE.test(trainingRef) ? eq(trainingIds.id, trainingRef) : eq(trainingIds.code, trainingRef))
    .limit(1);
  if (!training) throw new AppError("Training not found", 404);

  if (requireEnrolment) {
    const [enr] = await db
      .select({ id: enrolments.id })
      .from(enrolments)
      .innerJoin(participants, eq(enrolments.participantId, participants.id))
      .where(and(eq(enrolments.trainingId, training.id), eq(participants.userId, userId)))
      .limit(1);
    if (!enr) throw new AppError("You are not enrolled in this training", 403);
  }

  // Supplementary (this training) — by training id.
  const supp = await db
    .select()
    .from(courseResources)
    .where(and(
      eq(courseResources.trainingId, training.id),
      eq(courseResources.kind, "supplementary"),
      eq(courseResources.isActive, true)
    ))
    .orderBy(desc(courseResources.createdAt));

  // Predefined — the courseware for the training's course, resolved via the
  // training's course_slug → courses.slug link.
  let predefined = [];
  if (training.courseSlug) {
    const [course] = await db
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.slug, training.courseSlug))
      .limit(1);
    if (course) {
      predefined = await db
        .select()
        .from(courseResources)
        .where(and(
          eq(courseResources.courseId, course.id),
          eq(courseResources.kind, "predefined"),
          eq(courseResources.isActive, true)
        ))
        .orderBy(desc(courseResources.createdAt));
    }
  }

  return {
    training: { id: training.id, code: training.code },
    predefined: await shapeMany(predefined),
    supplementary: await shapeMany(supp),
  };
}

/**
 * Bulk-import supplementary LINK resources across trainings from a parsed CSV.
 * Each row names its training by code. Partial success: valid rows are created,
 * invalid rows (unknown training code) are reported. Files aren't importable
 * this way — every imported resource is an external link.
 */
export async function bulkImportSupplementaryResources({ resources }, userId, ip) {
  // Resolve all referenced training codes in one query.
  const codes = [...new Set(resources.map((r) => r.training_code))];
  const trainings = await db
    .select({ id: trainingIds.id, code: trainingIds.code })
    .from(trainingIds)
    .where(inArray(trainingIds.code, codes));
  const idByCode = new Map(trainings.map((t) => [t.code, t.id]));

  const validUrl = (u) => {
    try { const p = new URL(String(u)); return p.protocol === "http:" || p.protocol === "https:"; }
    catch { return false; }
  };

  const failed = [];
  const toInsert = [];
  resources.forEach((r, i) => {
    const fail = (error) => failed.push({ row: i + 1, training_code: r.training_code ?? null, title: r.title ?? null, error });
    const title = (r.title ?? "").trim();
    if (!r.training_code) return fail("Missing training code");
    const trainingId = idByCode.get(r.training_code);
    if (!trainingId) return fail("Unknown training code");
    if (!title) return fail("Title is required");
    if (!validUrl(r.url)) return fail("Invalid or missing URL");
    toInsert.push({
      courseId: null,
      trainingId,
      kind: "supplementary",
      title,
      description: r.description ?? null,
      resourceType: "link",
      externalUrl: String(r.url).trim(),
      isActive: r.is_active ?? true,
      uploadedBy: userId,
    });
  });

  let created = 0;
  if (toInsert.length) {
    const inserted = await db.insert(courseResources).values(toInsert).returning({ id: courseResources.id });
    created = inserted.length;
  }

  await writeAudit(db, {
    entityType: "course_resource",
    entityId: randomUUID(),
    action: "resources_bulk_import",
    actorId: userId,
    after: { requested: resources.length, created, failed: failed.length },
    ipAddress: ip,
  });

  return { created, failed };
}
