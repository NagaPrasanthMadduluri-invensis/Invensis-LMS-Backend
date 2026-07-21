ALTER TABLE "participants" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "address_line2" text;