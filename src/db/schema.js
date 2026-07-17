import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  date,
  time,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ── Enums ─────────────────────────────────────────────── */
export const roleEnum = pgEnum("role", ["admin", "trainer", "sponsor", "learner"]);
export const bucketEnum = pgEnum("bucket", ["direct_online", "corporate", "one_to_one_coaching"]);
export const deliveryModeEnum = pgEnum("delivery_mode", ["virtual", "in_person", "hybrid", "one_to_one"]);
export const batchTypeEnum = pgEnum("batch_type", ["weekday", "weekend", "combined"]);
export const trainingStatusEnum = pgEnum("training_status", ["pending", "active", "ongoing", "completed", "cancelled"]);
export const sessionStatusEnum = pgEnum("session_status", ["scheduled", "ongoing", "completed", "cancelled"]);
export const enrolmentStatusEnum = pgEnum("enrolment_status", ["confirmed", "cancelled", "transferred", "completed", "failed"]);
export const attendanceStatusEnum = pgEnum("attendance_status", ["not_marked", "present", "partial", "absent"]);
export const setupTokenPurposeEnum = pgEnum("setup_token_purpose", ["setup", "reset"]);
export const surveyTypeEnum = pgEnum("survey_type", ["pre_training", "post_training"]);
export const ticketCategoryEnum = pgEnum("ticket_category", ["reschedule_training", "cancel_training", "certificate_issue", "training_missed", "other"]);
export const ticketPriorityEnum = pgEnum("ticket_priority", ["low", "medium", "high", "urgent"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["open", "in_progress", "resolved", "closed"]);

/* ── users ─────────────────────────────────────────────── */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  passwordHash: text("password_hash"),
  isActive: boolean("is_active").notNull().default(true),
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── user_profiles (1:1 with users) ────────────────────────
   Extended, self-editable profile fields for the account owner. Kept out of
   `users` (which stays lean) and works for any role. `name` on users remains
   the display name, synced from first_name + last_name. avatar_key points at
   the object in R2 (see lib/storage.js). */
export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  userId: uuid("user_id").notNull().unique().references(() => users.id),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  country: text("country"),
  timeZone: text("time_zone"),
  preferredLanguage: text("preferred_language"),
  companyName: text("company_name"),
  jobTitle: text("job_title"),
  department: text("department"),
  yearsExperience: integer("years_experience"),
  linkedinUrl: text("linkedin_url"),
  avatarKey: text("avatar_key"), // R2 object key
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── password_setup_tokens ─────────────────────────────────
   Single-use, hashed tokens emailed to a user so they can set their initial
   password ('setup') or reset a forgotten one ('reset'). Only the SHA-256 hash
   of the token is stored; the raw token lives only in the email link. */
export const passwordSetupTokens = pgTable(
  "password_setup_tokens",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    purpose: setupTokenPurposeEnum("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }), // null until consumed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("uniq_setup_token_hash").on(t.tokenHash),
    userIdx: index("idx_setup_token_user").on(t.userId),
  })
);

export const revokedRefreshTokens = pgTable("revoked_refresh_tokens", {
  jti: text("jti").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── schedules ─────────────────────────────────────────────
   Predefined offering. Fields align with the xCRM schedule payload
   (start_date/end_date = range, start_time/end_time = daily window,
   session_dates = array of date strings). */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // xCRM traceability (null for manually created schedules)
    externalScheduleCode: text("external_schedule_code"), // e.g. "INL000006"
    externalEventId: integer("external_event_id"),
    externalVariantId: integer("external_variant_id"),

    title: text("title").notNull(),
    bucket: bucketEnum("bucket").notNull(),
    deliveryMode: deliveryModeEnum("delivery_mode").notNull(),
    batchType: batchTypeEnum("batch_type").notNull(),
    durationHours: integer("duration_hours"),
    capacity: integer("capacity").notNull(),
    minSeats: integer("min_seats").notNull(),

    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    startTime: time("start_time").notNull(), // daily window start
    endTime: time("end_time").notNull(), // daily window end
    sessionDates: jsonb("session_dates").notNull(), // ["2026-06-15", ...]
    venue: jsonb("venue"), // null for virtual
    timezone: text("timezone"),

    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id), // null = system/CRM
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalCodeUnique: uniqueIndex("uniq_schedule_external_code")
      .on(t.externalScheduleCode)
      .where(sql`external_schedule_code IS NOT NULL`),
  })
);

/* ── training_ids (operational anchor) ─────────────────────
   Meeting link fields are flattened here (the meeting_links table is removed). */
export const trainingIds = pgTable(
  "training_ids",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scheduleId: uuid("schedule_id").references(() => schedules.id), // null if manually created
    code: text("code").notNull().unique(), // TRN-YYYY-NNNN
    title: text("title").notNull(),
    bucket: bucketEnum("bucket").notNull(),
    deliveryMode: deliveryModeEnum("delivery_mode").notNull(),
    status: trainingStatusEnum("status").notNull().default("pending"),
    capacity: integer("capacity").notNull(),
    minSeats: integer("min_seats").notNull(),
    minSeatsOverride: boolean("min_seats_override").notNull().default(false),
    enrolledCount: integer("enrolled_count").notNull().default(0),

    // Meeting link — populated only when admin triggers release
    meetingUrl: text("meeting_url"),
    meetingPlatform: text("meeting_platform"), // zoom | teams | other
    meetingReleased: boolean("meeting_released").notNull().default(false),
    meetingTriggeredBy: uuid("meeting_triggered_by").references(() => users.id),
    meetingTriggeredAt: timestamp("meeting_triggered_at", { withTimezone: true }),

    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActivePerSchedule: uniqueIndex("uniq_active_training_per_schedule")
      .on(t.scheduleId)
      .where(sql`status <> 'cancelled' AND schedule_id IS NOT NULL`),
    statusCreated: index("idx_training_status_created").on(t.status, t.createdAt),
  })
);

/* ── training_sessions (day-wise; no title per override #7) ── */
export const trainingSessions = pgTable("training_sessions", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  trainingId: uuid("training_id").notNull().references(() => trainingIds.id),
  dayNumber: integer("day_number").notNull(),
  plannedTopics: text("planned_topics"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  status: sessionStatusEnum("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── trainers (certificates folded in as jsonb per override #4) ── */
export const trainers = pgTable("trainers", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  bio: text("bio"),
  experience: text("experience"),
  rate: numeric("rate"),
  certificates: jsonb("certificates").notNull().default(sql`'[]'::jsonb`),
  // Subject excellence — what the trainer is qualified to deliver (e.g. ["PMP",
  // "PRINCE2"]). Distinct from `certificates` (their own professional certs).
  specializations: jsonb("specializations").notNull().default(sql`'[]'::jsonb`),
  // Base location. is_remote flags trainers who deliver online only; city/country
  // may still be set for a remote trainer (where they're based).
  city: text("city"),
  country: text("country"),
  isRemote: boolean("is_remote").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── trainer_assignments (history preserved via removed_at) ── */
export const trainerAssignments = pgTable("trainer_assignments", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  trainingId: uuid("training_id").notNull().references(() => trainingIds.id),
  trainerId: uuid("trainer_id").notNull().references(() => trainers.id),
  assignedBy: uuid("assigned_by").notNull().references(() => users.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }), // null = currently assigned
});

/* ── participants ──────────────────────────────────────── */
export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  userId: uuid("user_id").references(() => users.id), // null until account activated
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  jobTitle: text("job_title"),
  // Learner location, sourced from the xCRM customer.billing block. Present for
  // every order regardless of delivery format (a live_virtual learner still has
  // a billing city/country) — this is what geo analytics keys off, not the venue.
  city: text("city"),
  country: text("country"),
  // Learner profile attributes — mirror the fields a learner fills in their
  // profile (user_profiles) / that arrive on the xCRM customer. Drive the
  // learner-demographic analytics. (job_title already above.)
  company: text("company"),
  department: text("department"),
  experienceYears: integer("experience_years"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── orders (received from xCRM; keyed by external order id) ── */
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  externalOrderId: text("external_order_id").notNull().unique(), // INV-20260608-VE2Q3H
  customerId: text("customer_id"),
  sponsorUserId: uuid("sponsor_user_id").references(() => users.id), // the buyer
  courseName: text("course_name"),
  paymentStatus: text("payment_status").notNull(),
  scheduleId: uuid("schedule_id").references(() => schedules.id),
  trainingId: uuid("training_id").references(() => trainingIds.id),
  payload: jsonb("payload"), // full received payload for traceability
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── enrolments ────────────────────────────────────────── */
export const enrolments = pgTable(
  "enrolments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    trainingId: uuid("training_id").notNull().references(() => trainingIds.id),
    participantId: uuid("participant_id").notNull().references(() => participants.id),
    orderId: uuid("order_id").references(() => orders.id), // null for manually-added enrolments
    status: enrolmentStatusEnum("status").notNull().default("confirmed"),
    // Overall attendance outcome, set once a training completes. 'not_marked'
    // until then. Drives the admin attendance analytics.
    attendanceStatus: attendanceStatusEnum("attendance_status").notNull().default("not_marked"),
    // Revenue attributes, sourced from the xCRM order + package. Amount is the
    // per-seat paid amount (order.paid_amount / quantity); tier is package.name.
    amount: numeric("amount"),
    currency: text("currency"),
    pricingTier: text("pricing_tier"),
    // Who paid — 'self' (individual / self-sponsored) vs 'corporate' (a company
    // sponsor). Mirrors the xCRM order.purchase_type. Powers the self-vs-corporate
    // analytics split.
    sponsorship: text("sponsorship"),
    repeatEligible: boolean("repeat_eligible").notNull().default(false),
    repeatApproved: boolean("repeat_approved").notNull().default(false),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActiveEnrolment: uniqueIndex("uniq_active_enrolment")
      .on(t.trainingId, t.participantId)
      .where(sql`status NOT IN ('cancelled', 'transferred')`),
  })
);

/* ── certificates (learner training certificates) ──────────
   Distinct from trainers.certificates (a trainer's own professional certs).
   A learner becomes ELIGIBLE for a certificate once their enrolment is marked
   'completed' (see admin completeEnrolment). Actually unlocking the download
   requires submitting the post-training feedback survey — that submission
   creates the row here, which stores the responses AND "issues" the
   certificate: a stable certificate code plus a snapshot of the activity/event
   code printed on it. One row per enrolment; its existence == unlocked. */
export const certificates = pgTable("certificates", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  enrolmentId: uuid("enrolment_id").notNull().unique().references(() => enrolments.id),
  certificateCode: text("certificate_code").notNull().unique(), // e.g. INVLJA4184
  activityCode: text("activity_code"), // schedule event code snapshot (falls back to training code)
  surveyResponses: jsonb("survey_responses").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── surveys (pre/post-training feedback forms) ────────────
   A questionnaire attached to a training. `questions` holds the ordered
   question objects; participants answer via survey_responses. */
export const surveys = pgTable(
  "surveys",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    trainingId: uuid("training_id").notNull().references(() => trainingIds.id),
    type: surveyTypeEnum("type").notNull(), // pre_training | post_training
    title: text("title").notNull(),
    questions: jsonb("questions").notNull(), // array of question objects
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    trainingIdx: index("idx_survey_training").on(t.trainingId),
  })
);

/* ── survey_responses ──────────────────────────────────────
   One row per participant per survey. `answers` maps question id → answer. */
export const surveyResponses = pgTable(
  "survey_responses",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    surveyId: uuid("survey_id").notNull().references(() => surveys.id),
    participantId: uuid("participant_id").notNull().references(() => participants.id),
    answers: jsonb("answers").notNull(), // question id → answer
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneResponsePerParticipant: uniqueIndex("uniq_survey_response").on(t.surveyId, t.participantId),
  })
);

/* ── audit_log (append-only) ───────────────────────────────
   NOTE: the spec mandates INSERT-only at the PostgreSQL role level. That is a
   deploy-time hardening step (a dedicated DB role with no UPDATE/DELETE) — the
   app only ever inserts here. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: uuid("actor_id").references(() => users.id), // null = system
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    ipAddress: text("ip_address"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("idx_audit_entity").on(t.entityType, t.entityId),
    actorIdx: index("idx_audit_actor_time").on(t.actorId, t.occurredAt),
  })
);

/* ── support tickets ───────────────────────────────────────
   Raised by a learner from the learner portal, triaged by admins in the
   Tickets module. Status-only workflow (no threaded replies); priority is
   derived from the category at creation. `training_id` is required for the
   training-related categories and null for 'other'. */
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    code: text("code").notNull().unique(), // TKT-YYYY-NNNN
    participantId: uuid("participant_id").notNull().references(() => participants.id),
    userId: uuid("user_id").references(() => users.id), // login identity of the raiser
    category: ticketCategoryEnum("category").notNull(),
    trainingId: uuid("training_id").references(() => trainingIds.id), // null for 'other'
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    status: ticketStatusEnum("status").notNull().default("open"),
    priority: ticketPriorityEnum("priority").notNull().default("medium"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    participantIdx: index("idx_ticket_participant").on(t.participantId, t.createdAt),
    statusIdx: index("idx_ticket_status_created").on(t.status, t.createdAt),
  })
);

/* ── ticket messages (conversation thread) ─────────────────
   Every reply on a ticket, from either the learner who raised it or an admin.
   Ordered by created_at to reconstruct the full conversation. */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
    authorId: uuid("author_id").references(() => users.id), // null = system note
    authorRole: text("author_role").notNull(), // 'admin' | 'learner'
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ticketIdx: index("idx_ticket_message_ticket").on(t.ticketId, t.createdAt),
  })
);
