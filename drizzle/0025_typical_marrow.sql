ALTER TABLE "certificates" DROP COLUMN "course_title_override";--> statement-breakpoint
ALTER TABLE "certificates" DROP COLUMN "start_date_override";--> statement-breakpoint
ALTER TABLE "certificates" DROP COLUMN "end_date_override";--> statement-breakpoint
-- Certificate codes move from a hash of the enrolment id to a running counter,
-- so they read as a sequence to anyone auditing them. Starts at 4446, which
-- continues the numbering already issued outside this system (last: INVLJA4445).
-- Existing certificates keep the codes they were issued with.
CREATE SEQUENCE IF NOT EXISTS certificate_code_seq START WITH 4446 INCREMENT BY 1;
