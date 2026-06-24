CREATE TYPE "public"."batch_type" AS ENUM('weekday', 'weekend', 'combined');--> statement-breakpoint
CREATE TYPE "public"."bucket" AS ENUM('direct_online', 'corporate', 'one_to_one_coaching');--> statement-breakpoint
CREATE TYPE "public"."delivery_mode" AS ENUM('virtual', 'in_person', 'hybrid', 'one_to_one');--> statement-breakpoint
CREATE TYPE "public"."enrolment_status" AS ENUM('confirmed', 'cancelled', 'transferred', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('scheduled', 'ongoing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."training_status" AS ENUM('pending', 'active', 'ongoing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_address" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"training_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"status" "enrolment_status" DEFAULT 'confirmed' NOT NULL,
	"repeat_eligible" boolean DEFAULT false NOT NULL,
	"repeat_approved" boolean DEFAULT false NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"job_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_schedule_code" text,
	"external_event_id" integer,
	"external_variant_id" integer,
	"title" text NOT NULL,
	"bucket" "bucket" NOT NULL,
	"delivery_mode" "delivery_mode" NOT NULL,
	"batch_type" "batch_type" NOT NULL,
	"duration_hours" integer,
	"capacity" integer NOT NULL,
	"min_seats" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"session_dates" jsonb NOT NULL,
	"venue" jsonb,
	"timezone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trainer_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"training_id" uuid NOT NULL,
	"trainer_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trainers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"bio" text,
	"experience" text,
	"rate" numeric,
	"certificates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_ids" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_id" uuid,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"bucket" "bucket" NOT NULL,
	"delivery_mode" "delivery_mode" NOT NULL,
	"status" "training_status" DEFAULT 'pending' NOT NULL,
	"capacity" integer NOT NULL,
	"min_seats" integer NOT NULL,
	"min_seats_override" boolean DEFAULT false NOT NULL,
	"enrolled_count" integer DEFAULT 0 NOT NULL,
	"meeting_url" text,
	"meeting_platform" text,
	"meeting_released" boolean DEFAULT false NOT NULL,
	"meeting_triggered_by" uuid,
	"meeting_triggered_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_ids_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "training_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"training_id" uuid NOT NULL,
	"day_number" integer NOT NULL,
	"planned_topics" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"status" "session_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainer_assignments" ADD CONSTRAINT "trainer_assignments_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainer_assignments" ADD CONSTRAINT "trainer_assignments_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainer_assignments" ADD CONSTRAINT "trainer_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainers" ADD CONSTRAINT "trainers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_ids" ADD CONSTRAINT "training_ids_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_ids" ADD CONSTRAINT "training_ids_meeting_triggered_by_users_id_fk" FOREIGN KEY ("meeting_triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_ids" ADD CONSTRAINT "training_ids_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor_time" ON "audit_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_active_enrolment" ON "enrolments" USING btree ("training_id","participant_id") WHERE status NOT IN ('cancelled', 'transferred');--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_active_training_per_schedule" ON "training_ids" USING btree ("schedule_id") WHERE status <> 'cancelled' AND schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_training_status_created" ON "training_ids" USING btree ("status","created_at");