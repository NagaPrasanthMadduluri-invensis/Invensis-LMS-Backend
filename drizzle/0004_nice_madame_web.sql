CREATE TYPE "public"."setup_token_purpose" AS ENUM('setup', 'reset');--> statement-breakpoint
CREATE TABLE "password_setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "setup_token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_setup_token_hash" ON "password_setup_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_setup_token_user" ON "password_setup_tokens" USING btree ("user_id");