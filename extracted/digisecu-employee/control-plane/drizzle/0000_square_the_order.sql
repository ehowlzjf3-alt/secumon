CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"kind" text NOT NULL,
	"domain" text,
	"persona" text,
	"role" text,
	"status" text,
	"heartbeat" text,
	"hot_start" boolean DEFAULT false NOT NULL,
	"accent" text,
	"workspace_key" text,
	"manager_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
