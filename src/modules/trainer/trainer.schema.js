import { z } from "zod";

export const updateTopicsSchema = z.object({
  planned_topics: z.string().min(1, "planned_topics is required"),
});

/* ── Trainer self-service profile ── */

const certificateSchema = z
  .object({
    title: z.string().trim().min(1),
    issued_by: z.string().trim().optional(),
    issued_date: z.string().trim().optional(),
    file_key: z.string().trim().optional(),
  })
  .passthrough();

const specializationsSchema = z.array(z.string().trim().min(1)).max(30);
const blankToNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);
const locationField = z.preprocess(blankToNull, z.string().trim().min(1).nullable().optional());

// A trainer may edit their own presentation details. Commercial terms (`rate`)
// and account status (`is_active`) stay admin-only, as does `email` (login id).
export const updateTrainerProfileSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    bio: z.string().trim().nullable().optional(),
    experience: z.string().trim().nullable().optional(),
    certificates: z.array(certificateSchema).optional(),
    specializations: specializationsSchema.optional(),
    city: locationField,
    country: locationField,
    is_remote: z.boolean().optional(),
    resume_key: z.string().trim().max(255).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const resumeUploadSchema = z.object({
  content_type: z.literal("application/pdf"),
});

export const markAttendanceSchema = z.object({
  records: z
    .array(
      z.object({
        participant_id: z.string().uuid(),
        status: z.enum(["present", "absent", "late", "excused"]),
      })
    )
    .min(1, "At least one record is required"),
});
