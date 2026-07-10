CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"certificate_code" text NOT NULL,
	"activity_code" text,
	"survey_responses" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificates_enrolment_id_unique" UNIQUE("enrolment_id"),
	CONSTRAINT "certificates_certificate_code_unique" UNIQUE("certificate_code")
);
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE no action ON UPDATE no action;