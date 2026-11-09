// Drizzle table definitions live here. Run `pnpm db:generate` after changing them to add a migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A person from the Entra Tenant the Gateway knows about, keyed by their Entra object ID: someone who has signed in,
 * or been added to a Workspace (looked up in Entra) before signing in.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraObjectId: text("entra_object_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  /** Mirrors the Platform Admin app role in the ID token of the most recent sign-in. */
  isPlatformAdmin: boolean("is_platform_admin").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  /** Null until the person first signs in. */
  lastSignedInAt: timestamptz("last_signed_in_at"),
});

/** A Web UI sign-in that has been sent to Entra and not yet come back. */
export const signInRequests = pgTable(
  "sign_in_requests",
  {
    state: text("state").primaryKey(),
    nonce: text("nonce").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("sign_in_requests_expires_at_idx").on(t.expiresAt)],
);

/** A signed-in Web UI browser. Only a hash of the cookie's token is stored. */
export const webSessions = pgTable(
  "web_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("web_sessions_user_id_idx").on(t.userId), index("web_sessions_expires_at_idx").on(t.expiresAt)],
);

/** A team or department inside the organization. */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("workspaces_name_unique").on(sql`lower(${t.name})`)],
);

export const standing = pgEnum("standing", ["admin", "member"]);

/** A User belonging to a Workspace, as a Workspace Admin or a member. */
export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    standing: standing("standing").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("memberships_user_id_idx").on(t.userId)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** `shared`: one credential for everyone's calls. `personal` is reserved for per-User credentials (not in v1). */
export const credentialMode = pgEnum("credential_mode", ["shared", "personal"]);
export const serverStatus = pgEnum("server_status", ["online", "offline"]);

/** An MCP server behind the Gateway, registered by a Workspace and reached over Streamable HTTP (ADR 0001). */
export const upstreamServers = pgTable(
  "upstream_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The Server Prefix. Immutable after registration. */
    prefix: text("prefix").notNull(),
    url: text("url").notNull(),
    credentialMode: credentialMode("credential_mode").notNull(),
    /** The Shared Credential's headers as JSON, sealed by the credential vault with the server id as context. */
    sharedCredential: bytea("shared_credential"),
    /** Names (not values) of the Shared Credential's headers, so the UI can say what is set. */
    credentialHeaderNames: text("credential_header_names").array().notNull(),
    /** Argument field names to mask in Audit Records, on top of the built-in defaults. */
    sensitiveFields: text("sensitive_fields").array().notNull(),
    status: serverStatus("status").notNull(),
    lastError: text("last_error"),
    lastContactAt: timestamptz("last_contact_at"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [unique("upstream_servers_workspace_prefix_unique").on(t.workspaceId, t.prefix)],
);

export const toolApproval = pgEnum("tool_approval", ["pending", "approved"]);

/** A tool discovered on an Upstream Server. */
export const upstreamTools = pgTable(
  "upstream_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => upstreamServers.id, { onDelete: "cascade" }),
    /** The tool's original name on the Upstream Server. */
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema").notNull(),
    /** SHA-256 of the canonical JSON of the input schema, to notice when it changes. */
    inputSchemaFingerprint: text("input_schema_fingerprint").notNull(),
    approval: toolApproval("approval").notNull(),
    discoveredAt: timestamptz("discovered_at").notNull(),
  },
  (t) => [unique("upstream_tools_server_name_unique").on(t.serverId, t.name)],
);
