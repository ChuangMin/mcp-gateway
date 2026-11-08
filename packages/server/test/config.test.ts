import { afterEach, describe, expect, test } from "vitest";
import { startGateway } from "../src/gateway.js";
import { createTestDatabase, validEnv } from "./support/harness.js";

let dropDatabase: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dropDatabase?.();
  dropDatabase = undefined;
});

async function envWith(overrides: Record<string, string | undefined>) {
  const database = await createTestDatabase();
  dropDatabase = database.drop;
  return { ...validEnv(database.url), ...overrides };
}

describe("the Gateway refuses to start with missing configuration", () => {
  test.each([
    "DATABASE_URL",
    "PUBLIC_BASE_URL",
    "ENCRYPTION_KEY",
    "ENTRA_TENANT_ID",
    "ENTRA_CLIENT_ID",
    "ENTRA_CLIENT_SECRET",
  ])("names %s when it is missing", async (name) => {
    const env = await envWith({ [name]: undefined });

    await expect(startGateway({ env, port: 0 })).rejects.toThrow(new RegExp(`${name}.*required`));
  });
});

describe("the Gateway refuses to start with invalid configuration", () => {
  test.each([
    ["DATABASE_URL", "mysql://localhost/gateway", /DATABASE_URL.*postgres/],
    ["PUBLIC_BASE_URL", "gateway.example.com", /PUBLIC_BASE_URL.*URL/],
    ["PUBLIC_BASE_URL", "ftp://gateway.example.com", /PUBLIC_BASE_URL.*http/],
    ["ENCRYPTION_KEY", Buffer.alloc(16).toString("base64"), /ENCRYPTION_KEY.*32 bytes/],
    ["ENCRYPTION_KEY", "not base64!", /ENCRYPTION_KEY.*32 bytes/],
    ["ENTRA_TENANT_ID", "contoso.onmicrosoft.com", /ENTRA_TENANT_ID.*GUID/],
    ["ENTRA_CLIENT_ID", "my-app", /ENTRA_CLIENT_ID.*GUID/],
    ["ENTRA_AUTHORITY_URL", "not a url", /ENTRA_AUTHORITY_URL.*URL/],
    ["GRAPH_BASE_URL", "not a url", /GRAPH_BASE_URL.*URL/],
  ])("rejects %s=%s", async (name, value, message) => {
    const env = await envWith({ [name]: value });

    await expect(startGateway({ env, port: 0 })).rejects.toThrow(message);
  });

  test("names every problem at once", async () => {
    const env = await envWith({ PUBLIC_BASE_URL: undefined, ENTRA_CLIENT_SECRET: undefined });

    await expect(startGateway({ env, port: 0 })).rejects.toThrow(/PUBLIC_BASE_URL[\s\S]*ENTRA_CLIENT_SECRET/);
  });
});
