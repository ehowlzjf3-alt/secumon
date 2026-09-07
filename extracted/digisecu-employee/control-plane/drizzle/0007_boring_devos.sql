CREATE TABLE "finding_triage" (
	"finding_ref" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'unclassified' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_triage_status_check" CHECK ("finding_triage"."status" in ('unclassified','investigating','action_requested','resolved','on_hold')),
	CONSTRAINT "finding_triage_version_positive" CHECK ("finding_triage"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "finding_triage_note" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_ref" text NOT NULL,
	"body" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finding_triage_note_ref_idx" ON "finding_triage_note" USING btree ("finding_ref","created_at");