import { z } from "zod";

// Confirmed-order payload from xCRM (crm_api.md §3). We validate the fields we
// consume and pass through the rest (stored on orders.payload for traceability).
const learnerSchema = z
  .object({
    name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().optional(),
  })
  .passthrough();

const scheduleSchema = z
  .object({
    schedule_id: z.string(), // external code, e.g. "INL000006"
    event_id: z.number().optional(),
    schedule_variant_id: z.number().optional(),
    batch_type: z.string().optional(),
    delivery_format: z.string().optional(),
    venue: z.any().optional(),
    timezone: z.string().optional(),
    start_date: z.string(),
    end_date: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    session_dates: z.array(z.string()).min(1),
    duration_hours: z.number().optional(),
    hours_per_day: z.union([z.number(), z.string()]).optional(), // e.g. 8 or "8"
    timezone_code: z.string().optional(), // fallback for `timezone`
  })
  .passthrough();

export const orderIntakeSchema = z
  .object({
    order_id: z.string(),
    customer_id: z.string().optional(),
    order: z
      .object({
        payment_status: z.string(),
        purchase_type: z.string().optional(),
      })
      .passthrough(),
    course: z
      .object({
        course_id: z.number().optional(),
        course_name: z.string(),
        duration_hours: z.number().optional(),
      })
      .passthrough(),
    // The buyer = the sponsor for this order (required; may also be a learner).
    buyer: z
      .object({
        customer_id: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        name: z.string().optional(),
        email: z.string().trim().toLowerCase().email(),
        phone: z.string().optional(),
        company_name: z.string().optional(),
      })
      .passthrough(),
    // Optional — an order may be placed before learners are assigned.
    learners: z.array(learnerSchema).optional(),
    schedule: scheduleSchema,
  })
  .passthrough();
