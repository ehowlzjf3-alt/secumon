ALTER TABLE "employees" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employees" DROP COLUMN "heartbeat";