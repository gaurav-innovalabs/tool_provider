ALTER TABLE "trigger_logs" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "trigger_logs" ADD COLUMN "payload" jsonb;