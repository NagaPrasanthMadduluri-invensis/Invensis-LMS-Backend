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
