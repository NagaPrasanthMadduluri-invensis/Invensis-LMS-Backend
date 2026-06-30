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

export const onboardTrainerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  bio: z.string().trim().optional(),
  experience: z.string().trim().optional(),
  rate: z.number().nonnegative().optional(),
  certificates: z.array(certificateSchema).optional(),
});

export const updateTrainerSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    bio: z.string().trim().optional(),
    experience: z.string().trim().optional(),
    rate: z.number().nonnegative().optional(),
    certificates: z.array(certificateSchema).optional(),
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

export const cancelEnrolmentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required"),
});

export const transferEnrolmentSchema = z.object({
  training_id: z.string().trim().min(1, "Target training_id (UUID or code) is required"),
  reason: z.string().trim().min(1, "A reason is required"),
});
