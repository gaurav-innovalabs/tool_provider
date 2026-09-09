CREATE TABLE "action_logs" (
	"log_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"action_key" text NOT NULL,
	"status" text NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"status" text NOT NULL,
	"credential" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_instances" (
	"trigger_instance_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"trigger_key" text NOT NULL,
	"status" text NOT NULL,
	"cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"user_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_connection_id_connections_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("connection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_instances" ADD CONSTRAINT "trigger_instances_connection_id_connections_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("connection_id") ON DELETE no action ON UPDATE no action;