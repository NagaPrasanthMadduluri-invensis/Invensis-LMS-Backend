-- Only confirmed trainings reach this platform: order ingestion has always
-- written "active" explicitly, and no code path ever assigns "pending". The
-- default is corrected so a row can no longer land there by omission.
ALTER TABLE "training_ids" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
-- Move the rows already sitting on the dead status. All of them are demo
-- fixtures; `active` is what the equivalent real training would be, and it
-- keeps them visible in the admin list rather than silently dropping them.
UPDATE "training_ids" SET "status" = 'active', "updated_at" = now() WHERE "status" = 'pending';
