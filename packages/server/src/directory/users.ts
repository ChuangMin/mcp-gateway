import type { Database } from "../db/database.js";
import { users } from "../db/schema.js";
import type { EntraIdentity } from "../identity/identity.js";

export type User = typeof users.$inferSelect;

/**
 * Records that `identity` signed in at `now`: creates the User on first sign-in, and otherwise refreshes the name,
 * email and Platform Admin standing from what Entra said this time.
 */
export async function recordSignIn(database: Database, identity: EntraIdentity, now: Date): Promise<User> {
  const fromEntra = { name: identity.name, email: identity.email, isPlatformAdmin: identity.isPlatformAdmin };
  const [user] = await database.db
    .insert(users)
    .values({ entraObjectId: identity.objectId, ...fromEntra, createdAt: now, lastSignedInAt: now })
    .onConflictDoUpdate({ target: users.entraObjectId, set: { ...fromEntra, lastSignedInAt: now } })
    .returning();
  return user!;
}
