CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_order_id" text NOT NULL,
	"customer_id" text,
	"course_name" text,
	"payment_status" text NOT NULL,
	"schedule_id" uuid,
	"training_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_external_order_id_unique" UNIQUE("external_order_id")
);
--> statement-breakpoint
ALTER TABLE "enrolments" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_schedule_external_code" ON "schedules" USING btree ("external_schedule_code") WHERE external_schedule_code IS NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_email_unique" UNIQUE("email");