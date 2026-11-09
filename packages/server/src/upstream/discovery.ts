import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { CredentialVault } from "../credential-vault.js";
import type { Database } from "../db/database.js";
import { upstreamServers, upstreamTools } from "../db/schema.js";
import { describeError, type DiscoveredTool, type UpstreamConnector, type UpstreamSession } from "./connector.js";

/** JSON with object keys sorted at every level, so equal values serialize identically. */
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

/** Identifies one version of a tool: what a Workspace Admin reviews when approving it. */
export const toolFingerprint = (tool: { description: string | null | undefined; inputSchema: unknown }) =>
  createHash("sha256")
    .update(canonicalJson({ description: tool.description ?? null, inputSchema: tool.inputSchema }))
    .digest("hex");

/** Credential context binding a sealed Shared Credential to its Upstream Server. */
export const credentialContext = (serverId: string) => `upstream_server:${serverId}`;

export interface ToolDiscovery {
  /**
   * Asks the Upstream Server for its tools now and records what changed, opening a session first if there is
   * none (or, with `reconnect`, replacing the one there is, e.g. after the credential changed). Calls for the same
   * server run one at a time; a call made while one is running is merged into a single follow-up. Never throws:
   * failures are recorded as the server's status.
   */
  refresh(serverId: string, options?: { reconnect?: boolean }): Promise<void>;
  /** Closes the session with a server that has been unregistered. */
  forget(serverId: string): Promise<void>;
  /** Starts re-discovering every server once its interval has passed. */
  start(): void;
  /** Stops all discovery and closes every session. */
  stop(): Promise<void>;
}

interface Queue {
  running?: Promise<void>;
  next?: Promise<void>;
  reconnect: boolean;
}

/**
 * Keeps the Gateway's record of each Upstream Server's tools current (ADR 0003): it holds a session with every
 * registered server, re-discovers its tools every `intervalMs` and whenever the server says they changed. New tools
 * are recorded pending; a known tool's description and schema are updated (which suspends an approved tool until it
 * is re-approved, see the registry); a tool the server stops offering is marked missing rather than deleted, so it
 * keeps its approval if it comes back unchanged.
 */
export function createToolDiscovery({
  database,
  clock,
  vault,
  connector,
  intervalMs,
  tickMs,
}: {
  database: Database;
  clock: Clock;
  vault: CredentialVault;
  connector: UpstreamConnector;
  intervalMs: number;
  /** How often to check which servers are due. Real time, unlike `intervalMs`, which follows the clock. */
  tickMs: number;
}): ToolDiscovery {
  const db = database.db;
  const sessions = new Map<string, UpstreamSession>();
  const lastAttempt = new Map<string, number>();
  const queues = new Map<string, Queue>();
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let stopped = false;

  const dropSession = async (serverId: string) => {
    const session = sessions.get(serverId);
    sessions.delete(serverId);
    await session?.close();
  };

  const headersOf = (serverId: string, sealed: Buffer | null): Record<string, string> => {
    if (sealed === null) return {};
    const headers = JSON.parse(vault.open(sealed, credentialContext(serverId))) as { name: string; value: string }[];
    return Object.fromEntries(headers.map((h) => [h.name, h.value]));
  };

  /** Records the tools the server offers now, and that it was reached. */
  const record = async (serverId: string, offered: DiscoveredTool[]) => {
    const now = clock.now();
    const byName = new Map(offered.map((tool) => [tool.name, tool]));
    await db.transaction(async (tx) => {
      const known = await tx
        .select({
          id: upstreamTools.id,
          name: upstreamTools.name,
          fingerprint: upstreamTools.fingerprint,
          missingSince: upstreamTools.missingSince,
        })
        .from(upstreamTools)
        .where(eq(upstreamTools.serverId, serverId));
        const knownByName = new Map(known.map((tool) => [tool.name, tool]));

      const discovered = [];
      for (const tool of byName.values()) {
        const fingerprint = toolFingerprint(tool);
        const current = { description: tool.description ?? null, inputSchema: tool.inputSchema, fingerprint };
        const existing = knownByName.get(tool.name);
        if (!existing) {
          discovered.push({ serverId, name: tool.name, ...current, approval: "pending" as const, discoveredAt: now });
        } else if (existing.fingerprint !== fingerprint || existing.missingSince !== null) {
          await tx
            .update(upstreamTools)
            .set({ ...current, missingSince: null })
            .where(eq(upstreamTools.id, existing.id));
        }
      }
      if (discovered.length > 0) await tx.insert(upstreamTools).values(discovered).onConflictDoNothing();

      const gone = known.filter((tool) => !byName.has(tool.name) && tool.missingSince === null).map((tool) => tool.id);
      if (gone.length > 0) {
        await tx.update(upstreamTools).set({ missingSince: now }).where(inArray(upstreamTools.id, gone));
      }

      await tx
        .update(upstreamServers)
        .set({ status: "online", lastError: null, lastContactAt: now })
        .where(eq(upstreamServers.id, serverId));
    });
  };

  const run = async (serverId: string, reconnect: boolean) => {
    if (stopped) return;
    const [server] = await db
      .select({ url: upstreamServers.url, sharedCredential: upstreamServers.sharedCredential })
      .from(upstreamServers)
      .where(eq(upstreamServers.id, serverId));
    if (!server) {
      lastAttempt.delete(serverId);
      await dropSession(serverId);
      return;
    }
    lastAttempt.set(serverId, clock.now().getTime());
    if (reconnect) await dropSession(serverId);

    try {
      let session = sessions.get(serverId);
      if (!session?.open) {
        await dropSession(serverId);
        session = await connector.connect(server.url, headersOf(serverId, server.sharedCredential), () => {
          void refresh(serverId);
        });
        if (stopped) {
          await session.close();
          return;
        }
        sessions.set(serverId, session);
      }
      await record(serverId, await session.listTools());
    } catch (error) {
      await dropSession(serverId);
      await db
        .update(upstreamServers)
        .set({ status: "offline", lastError: describeError(error) })
        .where(eq(upstreamServers.id, serverId));
    }
  };

  const start = (queue: Queue, serverId: string): Promise<void> => {
    const reconnect = queue.reconnect;
    queue.reconnect = false;
    const running: Promise<void> = run(serverId, reconnect)
      .catch((error) => console.error(`Tool discovery for Upstream Server ${serverId} failed:`, error))
      .finally(() => {
        if (queue.running === running) queue.running = undefined;
      });
    queue.running = running;
    return running;
  };

  const refresh = (serverId: string, options: { reconnect?: boolean } = {}): Promise<void> => {
    let queue = queues.get(serverId);
    if (!queue) {
      queue = { reconnect: false };
      queues.set(serverId, queue);
    }
    if (options.reconnect) queue.reconnect = true;
    if (queue.next) return queue.next;
    if (queue.running) {
      const q = queue;
      q.next = queue.running.then(() => {
        q.next = undefined;
        return start(q, serverId);
      });
      return q.next;
    }
    return start(queue, serverId);
  };

  const settled = async (serverId: string) => {
    const queue = queues.get(serverId);
    await (queue?.next ?? queue?.running);
  };

  const forget = async (serverId: string) => {
    await settled(serverId);
    queues.delete(serverId);
    lastAttempt.delete(serverId);
    await dropSession(serverId);
  };

  const tick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const servers = await db.select({ id: upstreamServers.id }).from(upstreamServers);
      const registered = new Set(servers.map((s) => s.id));
      // Servers removed without going through the registry, e.g. with their Workspace.
      for (const serverId of new Set([...sessions.keys(), ...lastAttempt.keys()])) {
        if (!registered.has(serverId)) void forget(serverId);
      }
      const now = clock.now().getTime();
      for (const { id } of servers) {
        const last = lastAttempt.get(id);
        if (last === undefined || now - last >= intervalMs) void refresh(id);
      }
    } catch (error) {
      console.error("Tool discovery could not read the Upstream Servers:", error);
    } finally {
      ticking = false;
    }
  };

  return {
    refresh,
    forget,
    start() {
      timer ??= setInterval(() => void tick(), tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all([...queues.keys()].map(settled));
      await Promise.all([...sessions.keys()].map(dropSession));
    },
  };
}
