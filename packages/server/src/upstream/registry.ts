import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { CredentialVault } from "../credential-vault.js";
import type { Database } from "../db/database.js";
import { upstreamServers, upstreamTools } from "../db/schema.js";
import { credentialContext, type ToolDiscovery } from "./discovery.js";

export type UpstreamServer = Omit<typeof upstreamServers.$inferSelect, "sharedCredential"> & {
  /** Tools a Workspace Admin has yet to decide on: pending, or approved but changed since. */
  toolsAwaitingReview: number;
};

/**
 * Where a tool stands. `changed`: approved, but its description or input schema has changed since, so it is
 * suspended until a Workspace Admin approves the new version (or it changes back to the approved one).
 */
export type ToolState = "pending" | "approved" | "rejected" | "changed";

type ToolRow = typeof upstreamTools.$inferSelect;
export type UpstreamTool = Omit<ToolRow, "approval"> & { state: ToolState };

/** A Workspace Admin's decision on a tool. `pending` revokes an earlier one. */
export type ToolDecision = "approved" | "rejected" | "pending";

export interface CredentialHeader {
  name: string;
  value: string;
}

export interface Registration {
  prefix: string;
  url: string;
  headers: CredentialHeader[];
  sensitiveFields: string[];
}

export type UpstreamErrorCode = "server_not_found" | "prefix_taken" | "tool_not_found" | "tool_changed";

export class UpstreamError extends Error {
  constructor(
    readonly code: UpstreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === UNIQUE_VIOLATION ||
  (error as { cause?: { code?: string } }).cause?.code === UNIQUE_VIOLATION;

const toolState = ({ approval, fingerprint, approvedFingerprint }: ToolRow): ToolState =>
  approval === "approved" && fingerprint !== approvedFingerprint ? "changed" : approval;

const publicColumns = {
  id: upstreamServers.id,
  workspaceId: upstreamServers.workspaceId,
  prefix: upstreamServers.prefix,
  url: upstreamServers.url,
  credentialMode: upstreamServers.credentialMode,
  credentialHeaderNames: upstreamServers.credentialHeaderNames,
  sensitiveFields: upstreamServers.sensitiveFields,
  status: upstreamServers.status,
  lastError: upstreamServers.lastError,
  lastContactAt: upstreamServers.lastContactAt,
  createdAt: upstreamServers.createdAt,
  // Written out in full: inside a select list Drizzle leaves column names unqualified, which here would be ambiguous.
  toolsAwaitingReview: sql<number>`(
    select count(*) from upstream_tools t
    where t.server_id = upstream_servers.id
      and t.missing_since is null
      and (t.approval = 'pending'
        or (t.approval = 'approved' and t.fingerprint is distinct from t.approved_fingerprint))
  )`.mapWith(Number),
};

/**
 * A Workspace's Upstream Servers and the tools discovered on them. Every operation is scoped to one Workspace, so a
 * server id from another Workspace is simply not found. Shared Credential values go in but never come back out.
 * Reaching the servers is left to tool discovery.
 */
export function createUpstreamRegistry({
  database,
  clock,
  vault,
  discovery,
}: {
  database: Database;
  clock: Clock;
  vault: CredentialVault;
  discovery: ToolDiscovery;
}) {
  const db = database.db;

  const seal = (serverId: string, headers: CredentialHeader[]) =>
    vault.seal(JSON.stringify(headers), credentialContext(serverId));

  const find = async (workspaceId: string, serverId: string): Promise<UpstreamServer> => {
    const [server] = await db
      .select(publicColumns)
      .from(upstreamServers)
      .where(and(eq(upstreamServers.workspaceId, workspaceId), eq(upstreamServers.id, serverId)));
    if (!server) throw new UpstreamError("server_not_found", "No such Upstream Server in this Workspace");
    return server;
  };

  return {
    async list(workspaceId: string): Promise<UpstreamServer[]> {
      return db
        .select(publicColumns)
        .from(upstreamServers)
        .where(eq(upstreamServers.workspaceId, workspaceId))
        .orderBy(asc(upstreamServers.prefix));
    },

    get: find,

    /** The tools the server currently offers. Ones it has stopped offering are left out. */
    async tools(serverId: string): Promise<UpstreamTool[]> {
      const rows = await db
        .select()
        .from(upstreamTools)
        .where(and(eq(upstreamTools.serverId, serverId), isNull(upstreamTools.missingSince)))
        .orderBy(asc(upstreamTools.name));
      return rows.map((row) => {
        const { approval: _, ...tool } = row;
        return { ...tool, state: toolState(row) };
      });
    },

    /**
     * Records a Workspace Admin's decision on some of a server's tools: all of them, or none if any is refused.
     * Approving names the fingerprint of the version reviewed, and is refused if the tool has changed since.
     */
    async decide(
      workspaceId: string,
      serverId: string,
      decision: ToolDecision,
      tools: { name: string; fingerprint?: string }[],
    ): Promise<void> {
      await find(workspaceId, serverId);
      const approving = decision === "approved";
      await db.transaction(async (tx) => {
        for (const tool of tools) {
          const offered = and(
            eq(upstreamTools.serverId, serverId),
            eq(upstreamTools.name, tool.name),
            isNull(upstreamTools.missingSince),
          );
          const updated = await tx
            .update(upstreamTools)
            .set({
              approval: decision,
              // Copied from the row in the same statement that checks the fingerprint, so the approved version is
              // exactly the one reviewed even if discovery changes the tool concurrently.
              approvedFingerprint: approving ? sql`${upstreamTools.fingerprint}` : null,
              approvedDescription: approving ? sql`${upstreamTools.description}` : null,
              approvedInputSchema: approving ? sql`${upstreamTools.inputSchema}` : null,
            })
            .where(approving ? and(offered, eq(upstreamTools.fingerprint, tool.fingerprint ?? "")) : offered)
            .returning({ id: upstreamTools.id });
          if (updated.length > 0) continue;

          const [exists] = await tx.select({ id: upstreamTools.id }).from(upstreamTools).where(offered);
          throw exists
            ? new UpstreamError("tool_changed", `"${tool.name}" has changed since it was reviewed; review it again`)
            : new UpstreamError("tool_not_found", `The Upstream Server offers no tool named "${tool.name}"`);
        }
      });
    },

    /**
     * Registers an Upstream Server with a Shared Credential, connecting to it at once. The server is registered
     * even when that connection fails; its status then says why, and discovery keeps trying.
     */
    async register(workspaceId: string, registration: Registration): Promise<UpstreamServer> {
      const existing = await db
        .select({ id: upstreamServers.id })
        .from(upstreamServers)
        .where(and(eq(upstreamServers.workspaceId, workspaceId), eq(upstreamServers.prefix, registration.prefix)));
      if (existing.length > 0) throw prefixTaken(registration.prefix);

      const id = randomUUID();
      try {
        await db.insert(upstreamServers).values({
          id,
          workspaceId,
          prefix: registration.prefix,
          url: registration.url,
          credentialMode: "shared",
          sharedCredential: seal(id, registration.headers),
          credentialHeaderNames: registration.headers.map((h) => h.name),
          sensitiveFields: registration.sensitiveFields,
          status: "offline",
          createdAt: clock.now(),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw prefixTaken(registration.prefix);
        throw error;
      }
      await discovery.refresh(id);
      return find(workspaceId, id);
    },

    /** Replaces the Shared Credential (e.g. to rotate a secret) and reconnects with it. */
    async replaceCredential(workspaceId: string, serverId: string, headers: CredentialHeader[]): Promise<UpstreamServer> {
      await find(workspaceId, serverId);
      await db
        .update(upstreamServers)
        .set({ sharedCredential: seal(serverId, headers), credentialHeaderNames: headers.map((h) => h.name) })
        .where(eq(upstreamServers.id, serverId));
      await discovery.refresh(serverId, { reconnect: true });
      return find(workspaceId, serverId);
    },

    async setSensitiveFields(workspaceId: string, serverId: string, sensitiveFields: string[]): Promise<UpstreamServer> {
      await find(workspaceId, serverId);
      await db.update(upstreamServers).set({ sensitiveFields }).where(eq(upstreamServers.id, serverId));
      return find(workspaceId, serverId);
    },

    async unregister(workspaceId: string, serverId: string): Promise<void> {
      const deleted = await db
        .delete(upstreamServers)
        .where(and(eq(upstreamServers.workspaceId, workspaceId), eq(upstreamServers.id, serverId)))
        .returning({ id: upstreamServers.id });
      if (deleted.length === 0) throw new UpstreamError("server_not_found", "No such Upstream Server in this Workspace");
      await discovery.forget(serverId);
    },
  };
}

const prefixTaken = (prefix: string) =>
  new UpstreamError("prefix_taken", `This Workspace already has an Upstream Server with the prefix "${prefix}"`);

export type UpstreamRegistry = ReturnType<typeof createUpstreamRegistry>;
