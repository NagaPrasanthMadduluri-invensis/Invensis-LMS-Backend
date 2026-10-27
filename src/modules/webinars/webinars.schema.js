import { z } from "zod";

// start_at / end_at are ISO instants (the client converts the admin's chosen
// date + time + timezone into UTC). `timezone` is the IANA zone used only to
// render the display label.
const base = {
  title: z.string().trim().min(3, "Title is required").max(200),
  speaker: z.string().trim().max(120).nullable().optional(),
  start_at: z.string().datetime({ offset: true }),
  end_at: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64),
  register_url: z.string().trim().url("Enter a valid URL").max(2000),
  is_active: z.boolean().optional(),
};

const endAfterStart = (d) =>
  !d.start_at || !d.end_at || new Date(d.end_at) > new Date(d.start_at);

export const createWebinarSchema = z
  .object(base)
  .refine(endAfterStart, { message: "End time must be after the start time", path: ["end_at"] });

export const updateWebinarSchema = z
  .object({
    title: base.title.optional(),
    speaker: base.speaker,
    start_at: base.start_at.optional(),
    end_at: base.end_at.optional(),
    timezone: base.timezone.optional(),
    register_url: base.register_url.optional(),
    is_active: base.is_active,
  })
  .refine((d) => !(d.start_at && d.end_at) || new Date(d.end_at) > new Date(d.start_at), {
    message: "End time must be after the start time",
    path: ["end_at"],
  });
