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
