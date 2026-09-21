ALTER TABLE "certificates" ADD COLUMN "pdus" integer;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "pdu_claim_code" text;--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "pdus" integer;--> statement-breakpoint
ALTER TABLE "training_ids" ADD COLUMN "pdu_claim_code" text;