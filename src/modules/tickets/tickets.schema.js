import { z } from "zod";

// The restricted set of categories a learner may raise a ticket under.
export const TICKET_CATEGORIES = [
  "reschedule_training",
  "cancel_training",
  "certificate_issue",
  "training_missed",
  "other",
];

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];

// Categories that must reference one of the learner's own trainings.
export const TRAINING_CATEGORIES = new Set([
  "reschedule_training",
  "cancel_training",
  "certificate_issue",
  "training_missed",
]);

// Priority is derived from the category at creation time (auto-priority).
export const CATEGORY_PRIORITY = {
  training_missed: "high",
  cancel_training: "high",
  reschedule_training: "medium",
  certificate_issue: "medium",
  other: "low",
};

export const createTicketSchema = z
  .object({
    category: z.enum(TICKET_CATEGORIES),
    training_id: z.string().uuid().optional(),
    subject: z.string().trim().min(3, "Subject is required").max(160),
    description: z.string().trim().min(10, "Please describe your issue").max(4000),
  })
  .refine((d) => !TRAINING_CATEGORIES.has(d.category) || !!d.training_id, {
    message: "Select the training this ticket is about",
    path: ["training_id"],
  });

export const updateTicketSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

export const ticketMessageSchema = z.object({
  body: z.string().trim().min(1, "Message can't be empty").max(4000),
});

export const listTicketsQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  search: z.string().trim().optional(),
});
