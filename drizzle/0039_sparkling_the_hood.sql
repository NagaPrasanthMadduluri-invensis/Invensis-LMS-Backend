CREATE TYPE "public"."exam_voucher_status" AS ENUM('not_booked', 'booked');--> statement-breakpoint
CREATE TABLE "exam_voucher_bookings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"status" "exam_voucher_status" DEFAULT 'not_booked' NOT NULL,
	"validity_months" integer,
	"booked_at" timestamp with time zone,
	"expires_at" date,
	"booked_by" uuid,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_voucher_bookings_enrolment_id_unique" UNIQUE("enrolment_id")
);
--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD CONSTRAINT "exam_voucher_bookings_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD CONSTRAINT "exam_voucher_bookings_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;