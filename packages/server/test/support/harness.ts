import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { startGateway, type RunningGateway } from "../../src/gateway.js";
import type { Clock } from "../../src/clock.js";
import { FakeEntra, type EntraPerson } from "./fake-entra.js";

export type { EntraPerson } from "./fake-entra.js";

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

/**
 * A browser talking to the Gateway: it keeps the Gateway's cookies and does not follow redirects, so tests see
 * each hop. Paths are relative to the Gateway's base URL.
 */
export class Browser {
  readonly #cookies = new Map<string, string>();

  constructor(
    readonly gatewayUrl: string,
    private readonly entra: FakeEntra,
  ) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set("cookie", [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(new URL(path, this.gatewayUrl), { ...init, headers, redirect: "manual" });
    for (const header of response.headers.getSetCookie()) this.#store(header);
    return response;
  }

  /** The value of one of the Gateway's cookies, if the browser holds it. */
  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  /**
   * Goes through the whole Web UI sign-in: Gateway → Entra (signing in as `person`) → Gateway callback.
   * Returns the Gateway's answer to the callback.
   */
  async signIn(person: EntraPerson): Promise<Response> {
    const start = await this.fetch("/auth/sign-in");
    const authorize = new URL(redirectTarget(start));
    if (!authorize.href.startsWith(this.entra.url)) {
      throw new Error(`sign-in redirected to ${authorize.href}, not to Entra`);
    }
    authorize.searchParams.set("fake_person", person.objectId);
    const atEntra = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(redirectTarget(atEntra));
    // The redirect URI is built from PUBLIC_BASE_URL; deliver it to the Gateway actually under test.
    return this.fetch(callback.pathname + callback.search);
  }

  #store(setCookie: string) {
    const [pair, ...attributes] = setCookie.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === "";
    if (expired) this.#cookies.delete(name);
    else this.#cookies.set(name, value);
  }
}

function redirectTarget(response: Response): string {
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) {
    throw new Error(`expected a redirect, got ${response.status}`);
  }
  return location;
}

export interface TestGateway {
  /** Sends an HTTP request to the running Gateway. `path` is relative to its base URL. */
  http(path: string, init?: RequestInit): Promise<Response>;
  /** A fresh browser with no cookies. */
  browser(): Browser;
  /** Signs `person` in with a fresh browser and returns it; fails the test if sign-in does not succeed. */
  signedIn(person: EntraPerson): Promise<Browser>;
  /** The fake Entra the Gateway is configured with. */
  entra: FakeEntra;
  clock: TestClock;
  /** Drops the Gateway's database out from under it, to simulate the database becoming unreachable. */
  dropDatabase(): Promise<void>;
  close(): Promise<void>;
}

export interface BootOptions {
  env?: Record<string, string>;
  webDistDir?: string;
}

/** Boots a whole Gateway in-process on a random port, against a fresh migrated database and a fake Entra. */
export async function bootGateway(options: BootOptions = {}): Promise<TestGateway> {
  const database = await createTestDatabase();
  const clock = new TestClock();
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const clientSecret = "test-client-secret";
  const entra = await FakeEntra.start({ tenantId, clientId, clientSecret, clock });
  let gateway: RunningGateway;
  try {
    gateway = await startGateway({
      env: {
        ...validEnv(database.url),
        ENTRA_TENANT_ID: tenantId,
        ENTRA_CLIENT_ID: clientId,
        ENTRA_CLIENT_SECRET: clientSecret,
        ENTRA_AUTHORITY_URL: entra.url,
        ...options.env,
      },
      clock,
      port: 0,
      webDistDir: options.webDistDir,
    });
  } catch (error) {
    await entra.close();
    await database.drop();
    throw error;
  }
  const browser = () => new Browser(gateway.url, entra);
  return {
    http: (path, init) => fetch(new URL(path, gateway.url), init),
    browser,
    signedIn: async (person) => {
      const b = browser();
      const response = await b.signIn(person);
      if (response.status !== 302 || response.headers.get("location") !== "/") {
        throw new Error(`sign-in failed: ${response.status} ${response.headers.get("location")}`);
      }
      return b;
    },
    entra,
    clock,
    dropDatabase: database.drop,
    close: async () => {
      await gateway.close();
      await entra.close();
      await database.drop();
    },
  };
}
