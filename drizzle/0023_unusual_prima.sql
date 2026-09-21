ALTER TABLE "certificates" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "released_by" uuid;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "download_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "last_downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "learner_name_override" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "course_title_override" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "start_date_override" date;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "end_date_override" date;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;