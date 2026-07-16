import { z } from "zod";

// Post-training feedback survey the learner completes to unlock their
// certificate download. Ratings are 1–5; comments optional.
export const certificateSurveySchema = z.object({
  overall_rating: z.coerce.number().int().min(1).max(5),
  trainer_rating: z.coerce.number().int().min(1).max(5),
  content_rating: z.coerce.number().int().min(1).max(5),
  would_recommend: z.boolean(),
  comments: z.string().trim().max(2000).optional(),
});

// General survey response — answers map question id → answer. Shape of each
// answer is owned by the frontend (matches the survey's questions), so it's
// stored flexibly; we only require a non-empty map.
export const submitSurveySchema = z.object({
  answers: z
    .record(z.string(), z.any())
    .refine((o) => Object.keys(o).length > 0, { message: "answers must contain at least one entry" }),
});
