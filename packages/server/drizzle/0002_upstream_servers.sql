CREATE TYPE "public"."credential_mode" AS ENUM('shared', 'personal');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."tool_approval" AS ENUM('pending', 'approved');--> statement-breakpoint
CREATE TABLE "upstream_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"url" text NOT NULL,
	"credential_mode" "credential_mode" NOT NULL,
	"shared_credential" "bytea",
	"credential_header_names" text[] NOT NULL,
	"sensitive_fields" text[] NOT NULL,
	"status" "server_status" NOT NULL,
	"last_error" text,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upstream_servers_workspace_prefix_unique" UNIQUE("workspace_id","prefix")
);
--> statement-breakpoint
CREATE TABLE "upstream_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"input_schema_fingerprint" text NOT NULL,
	"approval" "tool_approval" NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upstream_tools_server_name_unique" UNIQUE("server_id","name")
);
--> statement-breakpoint
ALTER TABLE "upstream_servers" ADD CONSTRAINT "upstream_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD CONSTRAINT "upstream_tools_server_id_upstream_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."upstream_servers"("id") ON DELETE cascade ON UPDATE no action;