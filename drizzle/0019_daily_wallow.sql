CREATE TYPE "public"."resource_kind" AS ENUM('predefined', 'supplementary');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('video', 'pdf', 'zip', 'word', 'excel', 'ppt', 'image', 'link', 'other');--> statement-breakpoint
CREATE TABLE "course_resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"course_id" uuid,
	"training_id" uuid,
	"kind" "resource_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"resource_type" "resource_type" NOT NULL,
	"storage_key" text,
	"file_name" text,
	"file_size" bigint,
	"content_type" text,
	"external_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"cms_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"description" text,
	"course_type" text,
	"certification_included" boolean DEFAULT false NOT NULL,
	"duration_hours" integer,
	"category_name" text,
	"category_slug" text,
	"icon_url" text,
	"banner_image_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "course_resources" ADD CONSTRAINT "course_resources_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_resources" ADD CONSTRAINT "course_resources_training_id_training_ids_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."training_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_resources" ADD CONSTRAINT "course_resources_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_resource_course" ON "course_resources" USING btree ("course_id","kind");--> statement-breakpoint
CREATE INDEX "idx_resource_training" ON "course_resources" USING btree ("training_id");--> statement-breakpoint
CREATE INDEX "idx_course_slug" ON "courses" USING btree ("slug");