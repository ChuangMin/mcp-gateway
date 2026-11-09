import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootGateway, type Browser, type TestGateway } from "./support/harness.js";
import { memberOf, send, workspaceWithAdmin } from "./support/rest.js";

let gateway: TestGateway;
let admin: Browser;
let workspaceId: string;
let servers: string;

beforeEach(async () => {
  gateway = await bootGateway();
  ({ admin, workspaceId } = await workspaceWithAdmin(gateway, "Payments"));
  servers = `/api/workspaces/${workspaceId}/servers`;
});
afterEach(async () => {
  await gateway.close();
});

const SECRET = "Bearer sk-live-0123456789abcdef";
const SEARCH = {
  name: "search",
  description: "Searches issues",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

function register(body: Record<string, unknown>, as: Browser = admin) {
  return send(as, "POST", servers, body);
}

describe("registering an Upstream Server", () => {
  test("connects with the Shared Credential and lists the tools it found, all pending", async () => {
    const upstream = await gateway.upstream({
      requireHeaders: { authorization: SECRET, "x-tenant": "acme" },
      tools: [SEARCH, { name: "create_issue" }],
    });

    const response = await register({
      prefix: "github",
      url: upstream.url,
      headers: [
        { name: "Authorization", value: SECRET },
        { name: "X-Tenant", value: "acme" },
      ],
      sensitiveFields: ["accountNumber"],
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      prefix: "github",
      url: upstream.url,
      credential: { mode: "shared", headerNames: ["Authorization", "X-Tenant"] },
      sensitiveFields: ["accountNumber"],
      status: "online",
      lastError: null,
      lastContactAt: gateway.clock.now().toISOString(),
      createdAt: gateway.clock.now().toISOString(),
      toolsAwaitingReview: 2,
      tools: [
        {
          name: "create_issue",
          namespacedName: "github__create_issue",
          description: null,
          inputSchema: { type: "object" },
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          approval: "pending",
          previouslyApproved: null,
          discoveredAt: gateway.clock.now().toISOString(),
        },
        {
          name: "search",
          namespacedName: "github__search",
          description: "Searches issues",
          inputSchema: SEARCH.inputSchema,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          approval: "pending",
          previouslyApproved: null,
          discoveredAt: gateway.clock.now().toISOString(),
        },
      ],
    });
  });

  test("sends the Shared Credential's headers on every request to the Upstream Server", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { "x-api-key": "k-123" }, tools: [SEARCH] });

    await register({ prefix: "github", url: upstream.url, headers: [{ name: "X-API-Key", value: "k-123" }] });

    expect(upstream.requests.length).toBeGreaterThan(0);
    for (const headers of upstream.requests) expect(headers["x-api-key"]).toBe("k-123");
  });

  test("works without a credential for a server that needs none", async () => {
    const upstream = await gateway.upstream({ tools: [SEARCH] });

    const response = await register({ prefix: "open", url: upstream.url });

    const server = await response.json();
    expect(server.status).toBe("online");
    expect(server.credential).toEqual({ mode: "shared", headerNames: [] });
  });

  test("reports a credential the Upstream Server rejects, and still registers the server", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { authorization: SECRET }, tools: [SEARCH] });

    const response = await register({
      prefix: "github",
      url: upstream.url,
      headers: [{ name: "Authorization", value: "Bearer wrong" }],
    });

    expect(response.status).toBe(201);
    const server = await response.json();
    expect(server).toMatchObject({ status: "offline", lastContactAt: null, tools: [] });
    expect(server.lastError).toMatch(/401/);
  });

  test("reports an Upstream Server that can't be reached", async () => {
    const upstream = await gateway.upstream();
    const url = upstream.url;
    await upstream.close();

    const server = await (await register({ prefix: "gone", url })).json();

    expect(server).toMatchObject({ status: "offline", lastContactAt: null, tools: [] });
    expect(server.lastError).toMatch(/ECONNREFUSED|fetch failed/);
  });

  test("does not follow a redirect, so the credential can't be sent to another host", async () => {
    const elsewhere = await gateway.upstream({ tools: [SEARCH] });
    const redirector = createServer((_, res) => res.writeHead(307, { location: elsewhere.url }).end());
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/mcp`;

      const server = await (
        await register({ prefix: "redirected", url, headers: [{ name: "X-API-Key", value: "k-123" }] })
      ).json();

      expect(server.status).toBe("offline");
      expect(elsewhere.requests).toEqual([]);
    } finally {
      redirector.closeAllConnections();
      await new Promise((resolve) => redirector.close(resolve));
    }
  });
});

describe("the Shared Credential", () => {
  test("is never returned by the API", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { authorization: SECRET }, tools: [SEARCH] });
    const registered = await register({
      prefix: "github",
      url: upstream.url,
      headers: [{ name: "Authorization", value: SECRET }],
    });
    const id = (await registered.clone().json()).id;

    const bodies = [
      await registered.text(),
      await (await admin.fetch(servers)).text(),
      await (await admin.fetch(`${servers}/${id}`)).text(),
      await (await send(admin, "PATCH", `${servers}/${id}`, { sensitiveFields: ["x"] })).text(),
    ];

    for (const body of bodies) expect(body).not.toContain("sk-live");
  });

  test("is encrypted at rest", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { authorization: SECRET } });
    await register({ prefix: "github", url: upstream.url, headers: [{ name: "Authorization", value: SECRET }] });

    const rows = await gateway.query<{ shared_credential: Buffer }>("select shared_credential from upstream_servers");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.shared_credential.toString("latin1")).not.toContain("sk-live");
    const everything = await gateway.query("select * from upstream_servers");
    expect(JSON.stringify(everything)).not.toContain("sk-live");
  });

  test("can be replaced, and the Gateway reconnects with the new one", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { authorization: "Bearer old" }, tools: [SEARCH] });
    const id = (
      await (
        await register({ prefix: "github", url: upstream.url, headers: [{ name: "Authorization", value: "Bearer old" }] })
      ).json()
    ).id;

    // The secret is rotated on the server; the Gateway's copy is now wrong until replaced.
    upstream.requireHeaders = { authorization: "Bearer new" };
    upstream.tools = [SEARCH, { name: "close_issue" }];
    gateway.clock.advance(60_000);
    const replaced = await send(admin, "PUT", `${servers}/${id}/credential`, {
      headers: [{ name: "Authorization", value: "Bearer new" }],
    });

    expect(replaced.status).toBe(200);
    const server = await replaced.json();
    expect(server).toMatchObject({ status: "online", lastError: null, lastContactAt: gateway.clock.now().toISOString() });
    expect(server.tools.map((t: { name: string }) => t.name)).toEqual(["close_issue", "search"]);
    expect(upstream.requests.at(-1)!.authorization).toBe("Bearer new");
  });

  test("replacing it with a wrong one is reported", async () => {
    const upstream = await gateway.upstream({ requireHeaders: { authorization: SECRET }, tools: [SEARCH] });
    const id = (
      await (await register({ prefix: "github", url: upstream.url, headers: [{ name: "Authorization", value: SECRET }] })).json()
    ).id;

    const server = await (
      await send(admin, "PUT", `${servers}/${id}/credential`, { headers: [{ name: "Authorization", value: "nope" }] })
    ).json();

    expect(server.status).toBe("offline");
    expect(server.lastError).toMatch(/401/);
    expect(server.tools).toHaveLength(1); // tools found earlier stay known
  });

  test.each([
    ["a header the Gateway sets itself", [{ name: "Content-Type", value: "text/plain" }]],
    ["an invalid header name", [{ name: "Bad Header", value: "x" }]],
    ["a value with a line break", [{ name: "Authorization", value: "Bearer x\r\nX-Evil: 1" }]],
    ["the same header twice", [{ name: "X-Key", value: "a" }, { name: "x-key", value: "b" }]],
  ])("refuses %s", async (_, headers) => {
    const upstream = await gateway.upstream();

    const response = await register({ prefix: "github", url: upstream.url, headers });

    expect(response.status).toBe(400);
    expect(upstream.requests).toEqual([]);
  });
});

describe("Server Prefix", () => {
  test.each(["GitHub", "git__hub", "_github", "github_", "git-hub", "git hub", "", "a".repeat(33)])(
    "refuses %j",
    async (prefix) => {
      const upstream = await gateway.upstream();

      const response = await register({ prefix, url: upstream.url });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_request");
    },
  );

  test.each(["github", "git_hub", "gh2", "a1_b2_c3", "a".repeat(32)])("accepts %j", async (prefix) => {
    const upstream = await gateway.upstream();

    expect((await register({ prefix, url: upstream.url })).status).toBe(201);
  });

  test("is unique within the Workspace, but another Workspace may use the same one", async () => {
    const upstream = await gateway.upstream();
    await register({ prefix: "github", url: upstream.url });
    const other = await workspaceWithAdmin(gateway, "Analytics");

    const clash = await register({ prefix: "github", url: upstream.url });
    const elsewhere = await send(other.admin, "POST", `/api/workspaces/${other.workspaceId}/servers`, {
      prefix: "github",
      url: upstream.url,
    });

    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe("prefix_taken");
    expect(elsewhere.status).toBe(201);
  });

  test("cannot be changed after registration", async () => {
    const upstream = await gateway.upstream();
    const id = (await (await register({ prefix: "github", url: upstream.url })).json()).id;

    const response = await send(admin, "PATCH", `${servers}/${id}`, { prefix: "gh" });

    expect(response.status).toBe(400);
    expect((await (await admin.fetch(`${servers}/${id}`)).json()).prefix).toBe("github");
  });
});

describe("only remote Upstream Servers (ADR 0001)", () => {
  test.each(["ftp://example.com/mcp", "file:///usr/bin/server", "stdio:npx some-server", "npx some-server", "ws://x/mcp"])(
    "refuses the URL %j",
    async (url) => {
      expect((await register({ prefix: "local", url })).status).toBe(400);
    },
  );

  test("refuses any attempt to give a command to launch", async () => {
    for (const extra of [{ command: "npx" }, { args: ["-y", "server"] }, { transport: "stdio" }, { env: { A: "1" } }]) {
      const response = await register({ prefix: "local", url: "https://example.com/mcp", ...extra });
      expect(response.status).toBe(400);
    }
  });

  test("refuses credentials embedded in the URL", async () => {
    const response = await register({ prefix: "github", url: "https://user:pass@example.com/mcp" });

    expect(response.status).toBe(400);
  });

  test("the Gateway's source has no way to launch a process", async () => {
    const root = join(import.meta.dirname, "..", "src");
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(join(root, file), "utf8");
      if (/child_process|client\/stdio|StdioClientTransport|\bspawn\(|\bexecFile\(/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe("managing registered servers", () => {
  test("sensitive argument fields can be changed", async () => {
    const upstream = await gateway.upstream();
    const id = (await (await register({ prefix: "github", url: upstream.url, sensitiveFields: ["pin"] })).json()).id;

    const response = await send(admin, "PATCH", `${servers}/${id}`, { sensitiveFields: ["pin", "iban"] });

    expect(response.status).toBe(200);
    expect((await response.json()).sensitiveFields).toEqual(["pin", "iban"]);
  });

  test("lists the Workspace's servers with their status", async () => {
    const online = await gateway.upstream({ tools: [SEARCH] });
    const offline = await gateway.upstream({ requireHeaders: { authorization: "x" } });
    await register({ prefix: "zeta", url: online.url });
    await register({ prefix: "alpha", url: offline.url });

    const list = await (await admin.fetch(servers)).json();

    expect(list.servers.map((s: { prefix: string; status: string }) => [s.prefix, s.status])).toEqual([
      ["alpha", "offline"],
      ["zeta", "online"],
    ]);
  });

  test("unregistering removes the server and its tools", async () => {
    const upstream = await gateway.upstream({ tools: [SEARCH] });
    const id = (await (await register({ prefix: "github", url: upstream.url })).json()).id;

    const response = await send(admin, "DELETE", `${servers}/${id}`);

    expect(response.status).toBe(204);
    expect((await admin.fetch(`${servers}/${id}`)).status).toBe(404);
    expect((await (await admin.fetch(servers)).json()).servers).toEqual([]);
    expect(await gateway.query("select * from upstream_tools")).toEqual([]);
    // The prefix is free again.
    expect((await register({ prefix: "github", url: upstream.url })).status).toBe(201);
  });

  test("members can see servers but not register, change or unregister them", async () => {
    const upstream = await gateway.upstream({ tools: [SEARCH] });
    const id = (await (await register({ prefix: "github", url: upstream.url })).json()).id;
    const member = await memberOf(gateway, admin, workspaceId);

    expect((await member.fetch(servers)).status).toBe(200);
    expect((await member.fetch(`${servers}/${id}`)).status).toBe(200);
    const attempts = [
      await register({ prefix: "other", url: upstream.url }, member),
      await send(member, "PATCH", `${servers}/${id}`, { sensitiveFields: [] }),
      await send(member, "PUT", `${servers}/${id}/credential`, { headers: [] }),
      await send(member, "DELETE", `${servers}/${id}`),
    ];
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  });
});

describe("isolation between Workspaces", () => {
  test("another Workspace's servers are invisible and untouchable", async () => {
    const upstream = await gateway.upstream({ tools: [SEARCH] });
    const id = (await (await register({ prefix: "github", url: upstream.url })).json()).id;
    const other = await workspaceWithAdmin(gateway, "Elsewhere");
    const theirServers = `/api/workspaces/${other.workspaceId}/servers`;

    // Through their own Workspace: our server id does not exist there.
    expect((await (await other.admin.fetch(theirServers)).json()).servers).toEqual([]);
    const viaOwn = [
      await other.admin.fetch(`${theirServers}/${id}`),
      await send(other.admin, "PATCH", `${theirServers}/${id}`, { sensitiveFields: [] }),
      await send(other.admin, "PUT", `${theirServers}/${id}/credential`, { headers: [] }),
      await send(other.admin, "DELETE", `${theirServers}/${id}`),
    ];
    // Through ours: they don't belong to it.
    const viaOurs = [
      await other.admin.fetch(servers),
      await other.admin.fetch(`${servers}/${id}`),
      await send(other.admin, "DELETE", `${servers}/${id}`),
    ];

    expect([...viaOwn, ...viaOurs].map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect((await admin.fetch(`${servers}/${id}`)).status).toBe(200);
  });
});
