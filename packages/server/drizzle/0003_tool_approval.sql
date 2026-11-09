ALTER TYPE "public"."tool_approval" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "fingerprint" text;--> statement-breakpoint
-- Placeholder for rows discovered before this migration (all still pending); the next discovery recomputes it.
UPDATE "upstream_tools" SET "fingerprint" = "input_schema_fingerprint";--> statement-breakpoint
ALTER TABLE "upstream_tools" ALTER COLUMN "fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_tools" DROP COLUMN "input_schema_fingerprint";--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_fingerprint" text;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_description" text;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_input_schema" jsonb;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "missing_since" timestamp with time zone;
