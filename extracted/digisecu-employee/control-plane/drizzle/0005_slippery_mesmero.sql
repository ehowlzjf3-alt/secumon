ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_source_check";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "desired" text DEFAULT 'Running' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_desired_check" CHECK ("employees"."desired" in ('Running','Paused','Terminated'));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_source_check" CHECK ("usage_events"."source" in ('operator_manual', 'pod_telemetry'));