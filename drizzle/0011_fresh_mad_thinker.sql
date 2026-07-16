CREATE TYPE "public"."survey_type" AS ENUM('pre_training', 'post_training');--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"survey_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"training_id" uuid NOT NULL,
	"type" "survey_type" NOT NULL,
	"title" text NOT NULL,
	"questions" jsonb NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_survey_response" ON "survey_responses" USING btree ("survey_id","participant_id");--> statement-breakpoint
CREATE INDEX "idx_survey_training" ON "surveys" USING btree ("training_id");