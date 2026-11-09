import { and, asc, eq, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { memberships, users, workspaces } from "../db/schema.js";
import type { EntraDirectory } from "../identity/entra-directory.js";
import type { User } from "./users.js";

export type Standing = "admin" | "member";
export type Workspace = typeof workspaces.$inferSelect;

export interface Member {
  user: Pick<User, "id" | "name" | "email">;
  standing: Standing;
}

export type DirectoryErrorCode =
  | "workspace_not_found"
  | "member_not_found"
  | "person_not_found"
  | "already_member"
  | "name_taken"
  | "last_workspace_admin";

/** A request the Directory refuses. `subject` names what it was about, e.g. the person who could not be found. */
export class DirectoryError extends Error {
  constructor(
    readonly code: DirectoryErrorCode,
    message: string,
    readonly subject?: string,
  ) {
    super(message);
    this.name = "DirectoryError";
  }
}

const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string; cause?: { code?: string } }).code === UNIQUE_VIOLATION ||
  (error as { cause?: { code?: string } }).cause?.code === UNIQUE_VIOLATION;

/**
 * Workspaces, the Users who belong to them, and each User's standing. Upholds the last-admin invariant: a Workspace
 * always has at least one Workspace Admin. Authorization is the caller's job; this module only keeps the rules.
 */
export function createDirectory({
  database,
  clock,
  entra,
}: {
  database: Database;
  clock: Clock;
  entra: EntraDirectory;
}) {
  const db = database.db;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /** Finds a person in the Entra Tenant and makes sure the Gateway has a User for them. */
  const resolvePerson = async (objectIdOrEmail: string): Promise<User> => {
    const person = await entra.findPerson(objectIdOrEmail.trim());
    if (!person) {
      throw new DirectoryError("person_not_found", `No one in the Entra Tenant is ${objectIdOrEmail}`, objectIdOrEmail);
    }
    const [user] = await db
      .insert(users)
      .values({
        entraObjectId: person.objectId,
        name: person.name,
        email: person.email,
        isPlatformAdmin: false,
        createdAt: clock.now(),
      })
      .onConflictDoUpdate({ target: users.entraObjectId, set: { name: person.name, email: person.email } })
      .returning();
    return user!;
  };

  /** Locks the Workspace row so membership changes to one Workspace happen one at a time. */
  const lockWorkspace = async (tx: Tx, workspaceId: string) => {
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!row) throw new DirectoryError("workspace_not_found", "No such Workspace");
    return row;
  };

  const membershipOf = async (tx: Tx, workspaceId: string, userId: string) => {
    const [row] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    if (!row) throw new DirectoryError("member_not_found", "That User is not a member of this Workspace");
    return row;
  };

  const refuseIfLastAdmin = async (tx: Tx, workspaceId: string) => {
    const [{ admins }] = (await tx
      .select({ admins: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.standing, "admin")))) as [{ admins: number }];
    if (admins <= 1) {
      throw new DirectoryError(
        "last_workspace_admin",
        "A Workspace must keep at least one Workspace Admin; promote someone else first",
      );
    }
  };

  const withNameCheck = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DirectoryError("name_taken", `A Workspace named "${name}" already exists`, name);
      }
      throw error;
    }
  };

  return {
    async listWorkspaces(): Promise<Workspace[]> {
      return db.select().from(workspaces).orderBy(asc(sql`lower(${workspaces.name})`));
    },

    async findWorkspace(workspaceId: string): Promise<Workspace | undefined> {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      return row;
    },

    /** The Workspaces a User belongs to, with their standing in each. */
    async workspacesOf(userId: string): Promise<Array<Workspace & { standing: Standing }>> {
      const rows = await db
        .select({ workspace: workspaces, standing: memberships.standing })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(sql`lower(${workspaces.name})`));
      return rows.map((r) => ({ ...r.workspace, standing: r.standing }));
    },

    /** The User's standing in a Workspace, or undefined if they don't belong to it. */
    async standingOf(workspaceId: string, userId: string): Promise<Standing | undefined> {
      const [row] = await db
        .select({ standing: memberships.standing })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
      return row?.standing;
    },

    /** Creates a Workspace whose initial Workspace Admins are the named people from the Entra Tenant. */
    async createWorkspace(name: string, adminObjectIdsOrEmails: string[]): Promise<Workspace> {
      const admins: User[] = [];
      for (const person of adminObjectIdsOrEmails) admins.push(await resolvePerson(person));
      const now = clock.now();
      return withNameCheck(name, () =>
        db.transaction(async (tx) => {
          const [workspace] = await tx.insert(workspaces).values({ name, createdAt: now }).returning();
          const unique = [...new Map(admins.map((a) => [a.id, a])).values()];
          await tx.insert(memberships).values(
            unique.map((admin) => ({
              workspaceId: workspace!.id,
              userId: admin.id,
              standing: "admin" as const,
              createdAt: now,
            })),
          );
          return workspace!;
        }),
      );
    },

    async renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
      const [row] = await withNameCheck(name, () =>
        db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId)).returning(),
      );
      if (!row) throw new DirectoryError("workspace_not_found", "No such Workspace");
      return row;
    },

    async deleteWorkspace(workspaceId: string): Promise<void> {
      const deleted = await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).returning();
      if (deleted.length === 0) throw new DirectoryError("workspace_not_found", "No such Workspace");
    },

    async members(workspaceId: string): Promise<Member[]> {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email, standing: memberships.standing })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(asc(sql`lower(${users.name})`));
      return rows.map(({ standing, ...user }) => ({ user, standing }));
    },

    /** Adds a person from the Entra Tenant to a Workspace. */
    async addMember(workspaceId: string, objectIdOrEmail: string, standing: Standing): Promise<Member> {
      const user = await resolvePerson(objectIdOrEmail);
      return db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId);
        const inserted = await tx
          .insert(memberships)
          .values({ workspaceId, userId: user.id, standing, createdAt: clock.now() })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) {
          throw new DirectoryError("already_member", `${user.email} already belongs to this Workspace`, user.email);
        }
        return { user: { id: user.id, name: user.name, email: user.email }, standing };
      });
    },

    /** Promotes or demotes a member. Demoting the last Workspace Admin is refused. */
    async setStanding(workspaceId: string, userId: string, standing: Standing): Promise<void> {
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId);
        const current = await membershipOf(tx, workspaceId, userId);
        if (current.standing === standing) return;
        if (current.standing === "admin") await refuseIfLastAdmin(tx, workspaceId);
        await tx
          .update(memberships)
          .set({ standing })
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
      });
    },

    /** Removes a member. Removing the last Workspace Admin is refused. */
    async removeMember(workspaceId: string, userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId);
        const current = await membershipOf(tx, workspaceId, userId);
        if (current.standing === "admin") await refuseIfLastAdmin(tx, workspaceId);
        await tx
          .delete(memberships)
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
      });
    },
  };
}

export type Directory = ReturnType<typeof createDirectory>;
