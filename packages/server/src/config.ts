import { z } from "zod";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function required(name: string) {
  return z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);
}

function url(name: string, protocols: string[], protocolMessage: string) {
  return required(name)
    .refine((value) => URL.canParse(value), `${name} must be a URL`)
    .refine((value) => !URL.canParse(value) || protocols.includes(new URL(value).protocol), protocolMessage);
}

function httpUrl(name: string) {
  return url(name, ["http:", "https:"], `${name} must be an http or https URL`);
}

function guid(name: string) {
  return required(name).regex(GUID, `${name} must be a GUID`);
}

const DEFAULT_DISCOVERY_INTERVAL_SECONDS = 300;
const MIN_DISCOVERY_INTERVAL_SECONDS = 10;

const EnvSchema = z.object({
  DATABASE_URL: url("DATABASE_URL", ["postgres:", "postgresql:"], "DATABASE_URL must be a postgres:// URL"),
  PUBLIC_BASE_URL: httpUrl("PUBLIC_BASE_URL"),
  ENCRYPTION_KEY: required("ENCRYPTION_KEY")
    .refine(
      (value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)",
    )
    .transform((value) => Buffer.from(value, "base64")),
  ENTRA_TENANT_ID: guid("ENTRA_TENANT_ID"),
  ENTRA_CLIENT_ID: guid("ENTRA_CLIENT_ID"),
  ENTRA_CLIENT_SECRET: required("ENTRA_CLIENT_SECRET"),
  ENTRA_AUTHORITY_URL: httpUrl("ENTRA_AUTHORITY_URL").default("https://login.microsoftonline.com"),
  GRAPH_BASE_URL: httpUrl("GRAPH_BASE_URL").default("https://graph.microsoft.com"),
  TOOL_DISCOVERY_INTERVAL_SECONDS: z
    .string()
    .trim()
    .regex(/^\d+$/, "TOOL_DISCOVERY_INTERVAL_SECONDS must be a whole number of seconds")
    .transform(Number)
    .refine((seconds) => seconds >= MIN_DISCOVERY_INTERVAL_SECONDS, {
      error: `TOOL_DISCOVERY_INTERVAL_SECONDS must be at least ${MIN_DISCOVERY_INTERVAL_SECONDS}`,
    })
    .default(DEFAULT_DISCOVERY_INTERVAL_SECONDS),
});

export interface Config {
  databaseUrl: string;
  publicBaseUrl: URL;
  encryptionKey: Buffer;
  entra: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    authorityUrl: URL;
  };
  graphBaseUrl: URL;
  /** How often the Gateway asks each Upstream Server for its tools, besides when the server says they changed. */
  toolDiscoveryIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Reads and validates configuration from environment variables. Throws a ConfigError naming every problem. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const blankAsMissing = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const result = EnvSchema.safeParse(blankAsMissing);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => issue.message));
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    publicBaseUrl: new URL(e.PUBLIC_BASE_URL),
    encryptionKey: e.ENCRYPTION_KEY,
    entra: {
      tenantId: e.ENTRA_TENANT_ID,
      clientId: e.ENTRA_CLIENT_ID,
      clientSecret: e.ENTRA_CLIENT_SECRET,
      authorityUrl: new URL(e.ENTRA_AUTHORITY_URL),
    },
    graphBaseUrl: new URL(e.GRAPH_BASE_URL),
    toolDiscoveryIntervalMs: e.TOOL_DISCOVERY_INTERVAL_SECONDS * 1000,
  };
}
