import { afterEach, expect, test } from "vitest";
import { bootGateway, type TestGateway } from "./support/harness.js";

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

test("GET /openapi.json describes the REST routes, including /health", async () => {
  gateway = await bootGateway();

  const response = await gateway.http("/openapi.json");

  expect(response.status).toBe(200);
  const document = await response.json();
  expect(document.openapi).toMatch(/^3\./);
  expect(document.info.title).toBe("mcp-gateway");
  expect(Object.keys(document.paths["/health"].get.responses)).toEqual(["200", "503"]);
  expect(document.components.schemas.HealthResponse.required).toEqual(["status", "database", "time"]);
});
