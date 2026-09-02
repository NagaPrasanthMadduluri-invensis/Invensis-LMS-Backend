import { z } from "zod";

// Reports = a sales/revenue-focused snapshot. Filters mirror the analytics
// filter set (so the two portals feel consistent) and every field is optional —
// an omitted field means "no constraint on this dimension". Empty strings from
// the query string are coerced to undefined so the frontend can send blanks.
const blankToUndef = (v) => (v === "" || v == null ? undefined : v);
const dateStr = z.preprocess(
  blankToUndef,
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").optional()
);

// Shared filter fields (report + records).
const filterShape = {
  from: dateStr,
  to: dateStr,
  delivery_mode: z.preprocess(
    blankToUndef,
    z.enum(["virtual", "in_person", "hybrid", "one_to_one"]).optional()
  ),
  bucket: z.preprocess(
    blankToUndef,
    z.enum(["direct_online", "corporate", "one_to_one_coaching"]).optional()
  ),
  status: z.preprocess(
    blankToUndef,
    z.enum(["pending", "active", "ongoing", "completed", "cancelled", "postponed", "suspended"]).optional()
  ),
  trainer_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  // Learner billing country, or the literal value shown in the location dropdown.
  location: z.preprocess(blankToUndef, z.string().trim().min(1).optional()),
  // Daily session length in whole hours (2 / 4 / 6 / 8 …).
  duration: z.preprocess(blankToUndef, z.coerce.number().int().positive().max(24).optional()),
  sponsorship: z.preprocess(blankToUndef, z.enum(["self", "corporate"]).optional()),
};

export const reportQuerySchema = z.object(filterShape);

// Raw row-level export — same filters, plus paging. Capped so a single request
// can't try to render an unbounded PDF; the frontend paginates if it wants more.
export const reportRecordsQuerySchema = z.object({
  ...filterShape,
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
});

// Attendance export — optional single-training scope, JSON (default) or CSV.
export const attendanceReportQuerySchema = z.object({
  training_id: z.preprocess(blankToUndef, z.string().trim().min(1).optional()),
  format: z.preprocess(blankToUndef, z.enum(["json", "csv"]).default("json")),
});
