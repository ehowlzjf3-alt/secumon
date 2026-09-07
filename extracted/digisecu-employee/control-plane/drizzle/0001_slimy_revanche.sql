CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target_id" text,
	"summary" text,
	"payload" jsonb,
	"requested_by" text NOT NULL,
	"requested_by_name" text,
	"gate" text,
	"note" text,
	"decided_by" text,
	"decided_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text,
	"summary" text NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "lifecycle" text DEFAULT 'Running' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "budget_monthly_cents" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "mail_send_mode" text DEFAULT 'dssoc_only' NOT NULL;