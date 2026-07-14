ALTER TABLE "enrolments" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "enrolments" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "enrolments" ADD COLUMN "pricing_tier" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "country" text;