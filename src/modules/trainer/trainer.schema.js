import { z } from "zod";

export const updateTopicsSchema = z.object({
  planned_topics: z.string().min(1, "planned_topics is required"),
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
