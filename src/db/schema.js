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
