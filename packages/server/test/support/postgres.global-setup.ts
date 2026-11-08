import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    postgresAdminUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** Starts one real, throwaway PostgreSQL for the whole test run. Each test gets its own database. */
export default async function setup(project: TestProject) {
  const dataDir = await mkdtemp(join(tmpdir(), "mcp-gateway-pg-"));
  const port = await freePort();
  const password = "postgres";
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide("postgresAdminUrl", `postgres://postgres:${password}@127.0.0.1:${port}/postgres`);

  return async () => {
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
