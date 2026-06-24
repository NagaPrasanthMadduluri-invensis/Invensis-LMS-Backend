import { z } from "zod";

export const updateTopicsSchema = z.object({
  planned_topics: z.string().min(1, "planned_topics is required"),
});
