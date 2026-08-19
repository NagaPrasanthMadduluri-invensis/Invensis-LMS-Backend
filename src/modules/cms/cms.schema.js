import { z } from "zod";

// Course catalogue filters — all optional, forwarded to the CMS as-is.
export const listCoursesQuerySchema = z.object({
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  course_group: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().optional(),
  per_page: z.coerce.number().int().positive().max(200).optional(),
});

// Schedule-listing query — country is optional (defaults on the server).
export const listSchedulesQuerySchema = z.object({
  country: z.string().trim().min(1).optional(),
});
