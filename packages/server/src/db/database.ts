import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface Database {
  db: NodePgDatabase<typeof schema>;
  /** Resolves true when a round trip to PostgreSQL succeeds. */
  isReachable(): Promise<boolean>;
  /**
   * Applies pending migrations. Safe to run repeatedly (applied migrations are skipped) and from several
   * Gateway instances at once (an advisory lock lets one instance migrate while the others wait).
   */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

// Arbitrary but fixed: identifies the Gateway's migration lock among other advisory locks on the server.
const MIGRATION_LOCK_KEY = 7_436_520_011;

export function openDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle client losing its connection must not crash the process; the next query reports it.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  return {
    db,
    isReachable: async () => {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    migrate: async () => {
      const lock = await pool.connect();
      try {
        await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        try {
          await migrate(db, { migrationsFolder });
        } finally {
          await lock.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        }
      } finally {
        lock.release();
      }
    },
    close: () => pool.end(),
  };
}
