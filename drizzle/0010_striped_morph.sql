ALTER TABLE "trainers" ADD COLUMN "specializations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trainers" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "trainers" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "trainers" ADD COLUMN "is_remote" boolean DEFAULT false NOT NULL;