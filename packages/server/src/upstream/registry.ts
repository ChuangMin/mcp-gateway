import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { CredentialVault } from "../credential-vault.js";
import type { Database } from "../db/database.js";
import { upstreamServers, upstreamTools } from "../db/schema.js";
import type { DiscoveredTool, ProbeResult, UpstreamConnector } from "./connector.js";

export type UpstreamServer = Omit<typeof upstreamServers.$inferSelect, "sharedCredential">;
export type UpstreamTool = typeof upstreamTools.$inferSelect;

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

export type UpstreamErrorCode = "server_not_found" | "prefix_taken";

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

/** JSON with object keys sorted at every level, so equal schemas serialize identically. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const schemaFingerprint = (schema: unknown) => createHash("sha256").update(canonicalJson(schema)).digest("hex");

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
};

/**
 * A Workspace's Upstream Servers and the tools discovered on them. Every operation is scoped to one Workspace, so a
 * server id from another Workspace is simply not found. Shared Credential values go in but never come back out.
 */
export function createUpstreamRegistry({
  database,
  clock,
  vault,
  connector,
}: {
  database: Database;
  clock: Clock;
  vault: CredentialVault;
  connector: UpstreamConnector;
}) {
  const db = database.db;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  const seal = (serverId: string, headers: CredentialHeader[]) =>
    vault.seal(JSON.stringify(headers), `upstream_server:${serverId}`);

  const toHeaderRecord = (headers: CredentialHeader[]) => Object.fromEntries(headers.map((h) => [h.name, h.value]));

  /** What a probe tells us about the server's status. */
  const statusFrom = (result: ProbeResult) =>
    result.ok
      ? { status: "online" as const, lastError: null, lastContactAt: clock.now() }
      : { status: "offline" as const, lastError: result.error };

  /** Records newly discovered tools as pending. Tools already known keep their state. */
  const recordTools = async (tx: Tx, serverId: string, tools: DiscoveredTool[]) => {
    if (tools.length === 0) return;
    await tx
      .insert(upstreamTools)
      .values(
        tools.map((tool) => ({
          serverId,
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema,
          inputSchemaFingerprint: schemaFingerprint(tool.inputSchema),
          approval: "pending" as const,
          discoveredAt: clock.now(),
        })),
      )
      .onConflictDoNothing();
  };

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

    async tools(serverId: string): Promise<UpstreamTool[]> {
      return db.select().from(upstreamTools).where(eq(upstreamTools.serverId, serverId)).orderBy(asc(upstreamTools.name));
    },

    /**
     * Registers an Upstream Server with a Shared Credential, connecting to it at once. The server is registered
     * even when that connection fails; its status then says why, and replacing the credential tries again.
     */
    async register(workspaceId: string, registration: Registration): Promise<UpstreamServer> {
      const existing = await db
        .select({ id: upstreamServers.id })
        .from(upstreamServers)
        .where(and(eq(upstreamServers.workspaceId, workspaceId), eq(upstreamServers.prefix, registration.prefix)));
      if (existing.length > 0) throw prefixTaken(registration.prefix);

      const probe = await connector.probe(registration.url, toHeaderRecord(registration.headers));
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(upstreamServers).values({
            id,
            workspaceId,
            prefix: registration.prefix,
            url: registration.url,
            credentialMode: "shared",
            sharedCredential: seal(id, registration.headers),
            credentialHeaderNames: registration.headers.map((h) => h.name),
            sensitiveFields: registration.sensitiveFields,
            ...statusFrom(probe),
            createdAt: clock.now(),
          });
          if (probe.ok) await recordTools(tx, id, probe.tools);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw prefixTaken(registration.prefix);
        throw error;
      }
      return find(workspaceId, id);
    },

    /** Replaces the Shared Credential (e.g. to rotate a secret) and reconnects with it. */
    async replaceCredential(workspaceId: string, serverId: string, headers: CredentialHeader[]): Promise<UpstreamServer> {
      const server = await find(workspaceId, serverId);
      const probe = await connector.probe(server.url, toHeaderRecord(headers));
      await db.transaction(async (tx) => {
        await tx
          .update(upstreamServers)
          .set({
            sharedCredential: seal(serverId, headers),
            credentialHeaderNames: headers.map((h) => h.name),
            ...statusFrom(probe),
          })
          .where(eq(upstreamServers.id, serverId));
        if (probe.ok) await recordTools(tx, serverId, probe.tools);
      });
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
    },
  };
}

const prefixTaken = (prefix: string) =>
  new UpstreamError("prefix_taken", `This Workspace already has an Upstream Server with the prefix "${prefix}"`);

export type UpstreamRegistry = ReturnType<typeof createUpstreamRegistry>;
