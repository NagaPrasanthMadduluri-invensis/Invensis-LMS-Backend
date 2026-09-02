ALTER TYPE "public"."training_status" ADD VALUE 'postponed';--> statement-breakpoint
ALTER TYPE "public"."training_status" ADD VALUE 'suspended';--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "status_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "postponed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_ids" ADD CONSTRAINT "training_ids_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;