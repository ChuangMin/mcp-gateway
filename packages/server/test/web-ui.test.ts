import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootGateway, type TestGateway } from "./support/harness.js";

let gateway: TestGateway;
let parentDir: string;

beforeEach(async () => {
  // A stand-in for the web package's build output, next to a file that must never be served.
  parentDir = await mkdtemp(join(tmpdir(), "mcp-gateway-web-"));
  const webDistDir = join(parentDir, "dist");
  await mkdir(join(webDistDir, "assets"), { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>mcp-gateway</title><div id=root></div>");
  await writeFile(join(webDistDir, "assets", "app.js"), "console.log('app')");
  await writeFile(join(parentDir, "secret.txt"), "do not serve");
  gateway = await bootGateway({ webDistDir });
});

afterEach(async () => {
  await gateway.close();
  await rm(parentDir, { recursive: true, force: true });
});

describe("the Web UI shell", () => {
  test("is served at /", async () => {
    const response = await gateway.http("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("<div id=root>");
  });

  test("serves its built assets", async () => {
    const response = await gateway.http("/assets/app.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(await response.text()).toBe("console.log('app')");
  });

  test("answers client-side routes with the shell, so deep links work", async () => {
    const response = await gateway.http("/workspaces/platform/audit");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<div id=root>");
  });

  test("returns 404 for a missing asset instead of the shell", async () => {
    const response = await gateway.http("/assets/missing.js");

    expect(response.status).toBe(404);
  });

  test("never serves files outside its build directory", async () => {
    const response = await gateway.http("/..%2Fsecret.txt");

    expect(await response.text()).not.toContain("do not serve");
  });

  test("leaves the REST routes alone", async () => {
    const response = await gateway.http("/health");

    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  });
});
