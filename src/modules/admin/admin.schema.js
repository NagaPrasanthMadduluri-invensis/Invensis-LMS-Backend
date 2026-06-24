import { z } from "zod";

export const updateTrainingSchema = z
  .object({
    trainer_id: z.string().uuid().optional(),
    meeting_url: z.string().url().optional(),
    meeting_platform: z.enum(["zoom", "teams", "other"]).optional(),
    meeting_released: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Provide trainer_id and/or meeting fields",
  });
