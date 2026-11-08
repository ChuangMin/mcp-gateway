import { afterEach, describe, expect, test } from "vitest";
import { bootGateway, type TestGateway } from "./support/harness.js";

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe("GET /health", () => {
  test("reports the Gateway and its database as reachable, at the Gateway's current time", async () => {
    gateway = await bootGateway();
    gateway.clock.set(new Date("2026-11-09T08:30:00.000Z"));

    const response = await gateway.http("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "reachable",
      time: "2026-11-09T08:30:00.000Z",
    });
  });

  test("reports the database as unreachable when PostgreSQL goes away", async () => {
    gateway = await bootGateway();
    gateway.clock.set(new Date("2026-11-09T08:31:00.000Z"));
    await gateway.dropDatabase();

    const response = await gateway.http("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "degraded",
      database: "unreachable",
      time: "2026-11-09T08:31:00.000Z",
    });
  });
});
