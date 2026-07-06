import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const setPasswordSchema = z.object({
  token: z.string().min(10, "Invalid token"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
