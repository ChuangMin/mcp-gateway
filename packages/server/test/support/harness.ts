import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { startGateway, type RunningGateway } from "../../src/gateway.js";
import type { Clock } from "../../src/clock.js";

/** A clock tests can set and move. */
export class TestClock implements Clock {
  #now: Date;
  constructor(start = new Date("2026-01-01T00:00:00.000Z")) {
    this.#now = start;
  }
  now(): Date {
    return new Date(this.#now);
  }
  set(to: Date): void {
    this.#now = new Date(to);
  }
  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

/** A complete, valid environment; tests override or delete entries to exercise config validation. */
export function validEnv(databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    PUBLIC_BASE_URL: "http://gateway.test",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_CLIENT_ID: randomUUID(),
    ENTRA_CLIENT_SECRET: "test-client-secret",
    ENTRA_AUTHORITY_URL: "http://entra.test",
    GRAPH_BASE_URL: "http://graph.test",
  };
}

function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject("postgresAdminUrl") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database for one test. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  return {
    url: withDatabase(inject("postgresAdminUrl"), name),
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => {}),
  };
}

export interface TestGateway {
  /** Sends an HTTP request to the running Gateway. `path` is relative to its base URL. */
  http(path: string, init?: RequestInit): Promise<Response>;
  clock: TestClock;
  /** Drops the Gateway's database out from under it, to simulate the database becoming unreachable. */
  dropDatabase(): Promise<void>;
  close(): Promise<void>;
}

export interface BootOptions {
  env?: Record<string, string>;
  webDistDir?: string;
}

/** Boots a whole Gateway in-process on a random port, against a fresh migrated database. */
export async function bootGateway(options: BootOptions = {}): Promise<TestGateway> {
  const database = await createTestDatabase();
  const clock = new TestClock();
  let gateway: RunningGateway;
  try {
    gateway = await startGateway({
      env: { ...validEnv(database.url), ...options.env },
      clock,
      port: 0,
      webDistDir: options.webDistDir,
    });
  } catch (error) {
    await database.drop();
    throw error;
  }
  return {
    http: (path, init) => fetch(new URL(path, gateway.url), init),
    clock,
    dropDatabase: database.drop,
    close: async () => {
      await gateway.close();
      await database.drop();
    },
  };
}
