CREATE TYPE "public"."exam_result" AS ENUM('pass', 'fail');--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD COLUMN "result" "exam_result";--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD COLUMN "result_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD COLUMN "result_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "exam_voucher_bookings" ADD CONSTRAINT "exam_voucher_bookings_result_updated_by_users_id_fk" FOREIGN KEY ("result_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;