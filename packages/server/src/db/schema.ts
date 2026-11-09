// Drizzle table definitions live here. Run `pnpm db:generate` after changing them to add a migration.
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A person from the Entra Tenant who has signed in at least once, keyed by their Entra object ID. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraObjectId: text("entra_object_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  /** Mirrors the Platform Admin app role in the ID token of the most recent sign-in. */
  isPlatformAdmin: boolean("is_platform_admin").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  lastSignedInAt: timestamptz("last_signed_in_at").notNull(),
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
