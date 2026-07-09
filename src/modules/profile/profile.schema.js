import { z } from "zod";

// All fields optional; null clears a field. At least one key required.
// Email is NOT here — it's the login identity and not editable.
const str = (max) => z.string().trim().max(max).nullable().optional();

export const updateProfileSchema = z
  .object({
    first_name: str(100),
    last_name: str(100),
    phone: str(30),
    country: str(100),
    time_zone: str(60),
    preferred_language: str(60),
    company_name: str(150),
    job_title: str(150),
    department: str(150),
    years_experience: z.number().int().min(0).max(80).nullable().optional(),
    linkedin_url: z.string().trim().url().max(255).nullable().optional(),
    avatar_key: str(255),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const avatarUploadSchema = z.object({
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
