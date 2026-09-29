import { z } from "zod";

const RESOURCE_TYPES = ["video", "pdf", "zip", "word", "excel", "ppt", "image", "link", "other"];

// Request a presigned upload URL for a resource file.
export const uploadUrlSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(255).optional(),
});

// Create a resource (predefined on a course, or supplementary on a training).
// Either `storage_key` (an already-uploaded R2 object) OR `external_url` (a link)
// must be present — validated in the service against `type`.
export const createResourceSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional().nullable(),
  type: z.enum(RESOURCE_TYPES).optional(),
  storage_key: z.string().trim().max(1024).optional(),
  file_name: z.string().trim().max(255).optional(),
  file_size: z.number().int().nonnegative().optional(),
  content_type: z.string().trim().max(255).optional(),
  external_url: z.string().trim().url().max(2048).optional(),
  is_active: z.boolean().optional(),
});

// Metadata-only update.
export const updateResourceSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  external_url: z.string().trim().url().max(2048).optional(),
  is_active: z.boolean().optional(),
});

/* ─────────────────────────────────────────────────────────
   Course catalogue — admin CRUD for locally-defined courses
   (courses that arrive via CRM orders but aren't in the CMS).
   ───────────────────────────────────────────────────────── */

const COURSE_TYPES = ["certification", "training_only"];

// Create a locally-defined course. `slug` is the join key trainings/resources/
// certificates link by, so it must match the slug the CRM order carries.
export const createCourseSchema = z.object({
  slug: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  short_name: z.string().trim().max(255).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  course_type: z.enum(COURSE_TYPES).optional().nullable(),
  certification_included: z.boolean().optional(),
  duration_hours: z.number().int().positive().optional().nullable(),
  category_name: z.string().trim().max(255).optional().nullable(),
  category_slug: z.string().trim().max(255).optional().nullable(),
  icon_url: z.string().trim().url().max(2048).optional().nullable(),
  banner_image_url: z.string().trim().url().max(2048).optional().nullable(),
  is_active: z.boolean().optional(),
});

// Update a course. `slug` is intentionally omitted — it's the immutable join key
// (changing it would orphan existing trainings/resources/certificates).
export const updateCourseSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    short_name: z.string().trim().max(255).optional().nullable(),
    description: z.string().trim().max(4000).optional().nullable(),
    course_type: z.enum(COURSE_TYPES).optional().nullable(),
    certification_included: z.boolean().optional(),
    duration_hours: z.number().int().positive().optional().nullable(),
    category_name: z.string().trim().max(255).optional().nullable(),
    category_slug: z.string().trim().max(255).optional().nullable(),
    icon_url: z.string().trim().url().max(2048).optional().nullable(),
    banner_image_url: z.string().trim().url().max(2048).optional().nullable(),
    is_active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" });
