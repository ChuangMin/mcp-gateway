import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
import { users, webSessions } from "./db/schema.js";
import type { User } from "./directory/users.js";

/** A Web UI session lasts this long from sign-in, then the person signs in again. */
export const WEB_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Web UI sessions, stored in PostgreSQL so any Gateway instance can serve them. */
export function createWebSessions({ database, clock }: { database: Database; clock: Clock }) {
  const db = database.db;
  return {
    /** Starts a session for `user` and returns the token for the browser's cookie. */
    async create(user: User): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      const now = clock.now();
      await db.delete(webSessions).where(lt(webSessions.expiresAt, now));
      await db.insert(webSessions).values({
        tokenHash: hash(token),
        userId: user.id,
        createdAt: now,
        expiresAt: new Date(now.getTime() + WEB_SESSION_LIFETIME_MS),
      });
      return token;
    },

    /** The signed-in User for a cookie token, or undefined if the session is unknown or over. */
    async find(token: string): Promise<User | undefined> {
      const [row] = await db
        .select({ user: users })
        .from(webSessions)
        .innerJoin(users, eq(webSessions.userId, users.id))
        .where(and(eq(webSessions.tokenHash, hash(token)), gt(webSessions.expiresAt, clock.now())));
      return row?.user;
    },

    async end(token: string): Promise<void> {
      await db.delete(webSessions).where(eq(webSessions.tokenHash, hash(token)));
    },
  };
}

export type WebSessions = ReturnType<typeof createWebSessions>;
