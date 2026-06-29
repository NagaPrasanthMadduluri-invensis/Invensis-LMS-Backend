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

export const addParticipantSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email(),
  phone: z.string().trim().min(1).optional(),
  job_title: z.string().trim().min(1).optional(),
});
