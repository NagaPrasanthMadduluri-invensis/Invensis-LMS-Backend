import { z } from "zod";

export const updateTrainingSchema = z
  .object({
    trainer_id: z.string().uuid().optional(),
    meeting_url: z.string().url().optional(),
    meeting_platform: z.enum(["zoom", "teams", "other"]).optional(),
    meeting_released: z.boolean().optional(),
    min_seats_override: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Provide trainer_id and/or meeting fields",
  });

export const addParticipantSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(1).optional(),
  job_title: z.string().trim().min(1).optional(),
});

const certificateSchema = z
  .object({
    title: z.string().trim().min(1),
    issued_by: z.string().trim().optional(),
    issued_date: z.string().trim().optional(),
    file_key: z.string().trim().optional(),
  })
  .passthrough();

// Subject excellence — free-form tag list, chosen from a preset list on the UI
// but not hard-restricted here so the list can grow without a schema change.
const specializationsSchema = z.array(z.string().trim().min(1)).max(30);
// Location fields. Nullable so the admin can clear them; blank strings coerce to
// null so an emptied input clears the value rather than storing "".
const blankToNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);
const locationField = z.preprocess(blankToNull, z.string().trim().min(1).nullable().optional());

export const onboardTrainerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  bio: z.string().trim().optional(),
  experience: z.string().trim().optional(),
  rate: z.number().nonnegative().optional(),
  certificates: z.array(certificateSchema).optional(),
  specializations: specializationsSchema.optional(),
  city: locationField,
  country: locationField,
  is_remote: z.boolean().optional(),
});

export const updateTrainerSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    bio: z.string().trim().optional(),
    experience: z.string().trim().optional(),
    rate: z.number().nonnegative().nullable().optional(),
    certificates: z.array(certificateSchema).optional(),
    specializations: specializationsSchema.optional(),
    city: locationField,
    country: locationField,
    is_remote: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const updateParticipantSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phone: z.string().trim().optional(),
    job_title: z.string().trim().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const listParticipantsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).optional(),
  job_title: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const cancelEnrolmentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required"),
});

// Analytics dashboard filters. Every field is optional — an omitted field means
// "no constraint on this dimension". Empty strings from the query string are
// coerced to undefined so the frontend can send blank params harmlessly.
const blankToUndef = (v) => (v === "" || v == null ? undefined : v);
const dateStr = z.preprocess(
  blankToUndef,
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").optional()
);

export const analyticsQuerySchema = z.object({
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
    z.enum(["pending", "active", "ongoing", "completed", "cancelled"]).optional()
  ),
  trainer_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  // Location = a venue city, or the literal "Virtual / Online" for online trainings.
  location: z.preprocess(blankToUndef, z.string().trim().min(1).optional()),
  // Daily session length in whole hours (2 / 4 / 6 / 8 …).
  duration: z.preprocess(blankToUndef, z.coerce.number().int().positive().max(24).optional()),
  // Learner-profile filters (enrolment grain).
  sponsorship: z.preprocess(blankToUndef, z.enum(["self", "corporate"]).optional()),
  job_title: z.preprocess(blankToUndef, z.string().trim().min(1).optional()),
  department: z.preprocess(blankToUndef, z.string().trim().min(1).optional()),
});

export const transferEnrolmentSchema = z.object({
  training_id: z.string().trim().min(1, "Target training_id (UUID or code) is required"),
  reason: z.string().trim().min(1, "A reason is required"),
});

// Survey authoring. `questions` is a flexible array of question objects — the
// frontend owns their exact shape, so we only require a non-empty array of objects.
export const createSurveySchema = z.object({
  type: z.enum(["pre_training", "post_training"]),
  title: z.string().trim().min(1, "Title is required"),
  questions: z.array(z.object({}).passthrough()).min(1, "At least one question is required"),
});
