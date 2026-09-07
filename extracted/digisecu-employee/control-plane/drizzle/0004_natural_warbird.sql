CREATE TABLE "budget_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"period_start" date NOT NULL,
	"additional_limit_cents" integer NOT NULL,
	"approval_id" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_grants_amount_positive" CHECK ("budget_grants"."additional_limit_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"period_start" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"source" text NOT NULL,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"approval_id" text,
	"note" text,
	CONSTRAINT "usage_events_amount_positive" CHECK ("usage_events"."amount_cents" > 0),
	CONSTRAINT "usage_events_source_check" CHECK ("usage_events"."source" in ('operator_manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "budget_grants_approval_uniq" ON "budget_grants" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "budget_grants_emp_period_idx" ON "budget_grants" USING btree ("employee_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotency_uniq" ON "usage_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_emp_period_idx" ON "usage_events" USING btree ("employee_id","period_start");