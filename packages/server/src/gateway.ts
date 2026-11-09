import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { createApp } from "./http/app.js";
import { createCredentialVault } from "./credential-vault.js";
import { createDirectory } from "./directory/directory.js";
import { createUpstreamConnector } from "./upstream/connector.js";
import { createToolDiscovery } from "./upstream/discovery.js";
import { createUpstreamRegistry } from "./upstream/registry.js";
import { createEntraDirectory } from "./identity/entra-directory.js";
import { createIdentity } from "./identity/identity.js";
import { createWebSessions } from "./web-sessions.js";

export interface StartOptions {
  env: Record<string, string | undefined>;
  clock?: Clock;
  port?: number;
  /** Interface to listen on. Defaults to 127.0.0.1; containers pass 0.0.0.0. */
  hostname?: string;
  /** Defaults to the web package's build output inside this repository. */
  webDistDir?: string;
  /** How often (real time) to check which Upstream Servers are due for tool re-discovery. Tests shorten it. */
  discoveryTickMs?: number;
}

export interface RunningGateway {
  url: string;
  close(): Promise<void>;
}

const defaultWebDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

export async function startGateway(options: StartOptions): Promise<RunningGateway> {
  const config = loadConfig(options.env);
  const clock = options.clock ?? systemClock;
  const database = openDatabase(config.databaseUrl);
  try {
    await database.migrate();
  } catch (error) {
    await database.close();
    throw error;
  }
  const vault = createCredentialVault(config.encryptionKey);
  const discovery = createToolDiscovery({
    database,
    clock,
    vault,
    connector: createUpstreamConnector(),
    intervalMs: config.toolDiscoveryIntervalMs,
    tickMs: options.discoveryTickMs ?? 5_000,
  });
  const app = createApp({
    config,
    clock,
    database,
    identity: createIdentity({ config, clock, database }),
    sessions: createWebSessions({ database, clock }),
    directory: createDirectory({ database, clock, entra: createEntraDirectory({ config, clock }) }),
    upstreams: createUpstreamRegistry({ database, clock, vault, discovery }),
    webDistDir: options.webDistDir ?? defaultWebDistDir,
  });
  const hostname = options.hostname ?? "127.0.0.1";

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: options.port ?? 3000, hostname }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  discovery.start();

  return {
    url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await discovery.stop();
      await database.close();
    },
  };
}
