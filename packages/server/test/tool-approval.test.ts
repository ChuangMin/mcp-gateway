import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bootGateway, type Browser, type FakeTool, type FakeUpstream, type TestGateway } from "./support/harness.js";
import { memberOf, send, workspaceWithAdmin } from "./support/rest.js";

const INTERVAL_SECONDS = 300;

let gateway: TestGateway;
let admin: Browser;
let workspaceId: string;
let upstream: FakeUpstream;
let server: string;

const SEARCH: FakeTool = {
  name: "search",
  description: "Searches issues",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};
const CREATE: FakeTool = { name: "create_issue", description: "Creates an issue" };

beforeEach(async () => {
  gateway = await bootGateway({ env: { TOOL_DISCOVERY_INTERVAL_SECONDS: String(INTERVAL_SECONDS) } });
  ({ admin, workspaceId } = await workspaceWithAdmin(gateway, "Payments"));
  upstream = await gateway.upstream({ tools: [SEARCH, CREATE] });
  const response = await send(admin, "POST", `/api/workspaces/${workspaceId}/servers`, {
    prefix: "github",
    url: upstream.url,
    headers: [],
    sensitiveFields: [],
  });
  expect(response.status).toBe(201);
  server = `/api/workspaces/${workspaceId}/servers/${(await response.json()).id}`;
});
afterEach(async () => {
  await gateway.close();
});

interface ToolView {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  fingerprint: string;
  approval: "pending" | "approved" | "rejected" | "changed";
  previouslyApproved: { description: string | null; inputSchema: Record<string, unknown> } | null;
}

async function tools(as: Browser = admin): Promise<ToolView[]> {
  const response = await send(as, "GET", server);
  expect(response.status).toBe(200);
  return (await response.json()).tools;
}

async function tool(name: string): Promise<ToolView | undefined> {
  return (await tools()).find((t) => t.name === name);
}

const approvals = (state: ToolView[]) => Object.fromEntries(state.map((t) => [t.name, t.approval]));

function decide(decision: "approved" | "rejected" | "pending", items: { name: string; fingerprint?: string }[], as = admin) {
  return send(as, "POST", `${server}/tools/approval`, { decision, tools: items });
}

/** Approves the named tools as they currently are. */
async function approve(...names: string[]) {
  const current = await tools();
  const response = await decide(
    "approved",
    names.map((name) => ({ name, fingerprint: current.find((t) => t.name === name)!.fingerprint })),
  );
  expect(response.status).toBe(200);
}

/** Waits for the Gateway's background discovery to reach a state. */
const eventually = (assertion: () => Promise<void>) => vi.waitFor(assertion, { timeout: 5000, interval: 20 });

/** Lets the Gateway's background discovery run several times. */
const severalTicks = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("reviewing tools", () => {
  test("a Workspace Admin sees each pending tool's name, description and input schema", async () => {
    expect(await tool("search")).toMatchObject({
      name: "search",
      description: "Searches issues",
      inputSchema: SEARCH.inputSchema,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      approval: "pending",
      previouslyApproved: null,
    });
  });

  test("the server says how many tools await review", async () => {
    const list = async () => (await (await send(admin, "GET", `/api/workspaces/${workspaceId}/servers`)).json()).servers;
    expect((await list())[0].toolsAwaitingReview).toBe(2);

    await approve("search");

    expect((await list())[0].toolsAwaitingReview).toBe(1);
  });

  test("tools can be approved one at a time", async () => {
    await approve("search");

    expect(approvals(await tools())).toEqual({ search: "approved", create_issue: "pending" });
  });

  test("tools can be approved in bulk", async () => {
    await approve("search", "create_issue");

    expect(approvals(await tools())).toEqual({ search: "approved", create_issue: "approved" });
  });

  test("the answer lists the server's tools as they now stand", async () => {
    const { fingerprint } = (await tool("search"))!;
    const response = await decide("approved", [{ name: "search", fingerprint }]);

    expect(response.status).toBe(200);
    expect(approvals((await response.json()).tools)).toEqual({ search: "approved", create_issue: "pending" });
  });

  test("tools can be rejected, individually or in bulk, without a fingerprint", async () => {
    expect((await decide("rejected", [{ name: "search" }, { name: "create_issue" }])).status).toBe(200);

    expect(approvals(await tools())).toEqual({ search: "rejected", create_issue: "rejected" });
  });

  test("an approval can be revoked, returning the tool to pending", async () => {
    await approve("search");

    expect((await decide("pending", [{ name: "search" }])).status).toBe(200);

    expect(await tool("search")).toMatchObject({ approval: "pending", previouslyApproved: null });
  });

  test("an approved tool can later be rejected, and a rejected one approved", async () => {
    await approve("search");
    await decide("rejected", [{ name: "search" }]);
    expect((await tool("search"))!.approval).toBe("rejected");

    await approve("search");
    expect((await tool("search"))!.approval).toBe("approved");
  });

  test("approving needs the fingerprint of the version reviewed", async () => {
    const response = await decide("approved", [{ name: "search" }]);

    expect(response.status).toBe(400);
    expect((await tool("search"))!.approval).toBe("pending");
  });

  test("approving a version that is no longer current is refused, and nothing in the batch changes", async () => {
    const reviewed = await tools();
    upstream.tools = [{ ...SEARCH, description: "Searches issues, then deletes them" }, CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect((await tool("search"))!.description).toContain("deletes"));

    const response = await decide(
      "approved",
      reviewed.map(({ name, fingerprint }) => ({ name, fingerprint })),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("tool_changed");
    expect(approvals(await tools())).toEqual({ search: "pending", create_issue: "pending" });
  });

  test("an unknown tool is not found, and nothing in the batch changes", async () => {
    const { fingerprint } = (await tool("search"))!;
    const response = await decide("approved", [
      { name: "search", fingerprint },
      { name: "nope", fingerprint },
    ]);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("tool_not_found");
    expect((await tool("search"))!.approval).toBe("pending");
  });

  test.each([
    [{ decision: "maybe", tools: [{ name: "search" }] }],
    [{ decision: "rejected", tools: [] }],
    [{ decision: "rejected" }],
    [{ decision: "rejected", tools: ["search"] }],
  ])("rejects a malformed decision %j", async (body) => {
    const response = await send(admin, "POST", `${server}/tools/approval`, body);

    expect(response.status).toBe(400);
  });

  test("members can see tools but not decide on them", async () => {
    const member = await memberOf(gateway, admin, workspaceId);

    expect(approvals(await tools(member))).toEqual({ search: "pending", create_issue: "pending" });
    expect((await decide("rejected", [{ name: "search" }], member)).status).toBe(403);
    expect((await tool("search"))!.approval).toBe("pending");
  });

  test("another Workspace's admin can't decide on them", async () => {
    const other = await workspaceWithAdmin(gateway, "Other");

    expect((await decide("rejected", [{ name: "search" }], other.admin)).status).toBe(404);
  });
});

describe("re-discovery", () => {
  test("happens again once the interval has passed, and new tools start pending", async () => {
    await approve("search", "create_issue");
    upstream.tools = [SEARCH, CREATE, { name: "delete_repo" }];

    gateway.clock.advance(INTERVAL_SECONDS * 1000 - 1);
    await severalTicks();
    expect(await tool("delete_repo")).toBeUndefined();

    gateway.clock.advance(1);
    await eventually(async () => expect((await tool("delete_repo"))?.approval).toBe("pending"));
    expect(approvals(await tools())).toEqual({ search: "approved", create_issue: "approved", delete_repo: "pending" });
  });

  test("happens when the Upstream Server says its tool list changed", async () => {
    upstream.tools = [SEARCH, CREATE, { name: "delete_repo" }];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("delete_repo"))?.approval).toBe("pending"));
  });

  test("keeps listening for changes after the credential is replaced", async () => {
    await send(admin, "PUT", `${server}/credential`, { headers: [{ name: "Authorization", value: "Bearer new" }] });
    upstream.tools = [SEARCH, { name: "delete_repo" }];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("delete_repo"))?.approval).toBe("pending"));
  });

  test("uses the replaced credential", async () => {
    upstream.requireHeaders = { authorization: "Bearer new" };
    await send(admin, "PUT", `${server}/credential`, { headers: [{ name: "Authorization", value: "Bearer new" }] });
    const before = upstream.requests.length;

    gateway.clock.advance(INTERVAL_SECONDS * 1000);
    await eventually(async () => expect(upstream.requests.length).toBeGreaterThan(before));
    expect(upstream.requests.slice(before).every((r) => r.authorization === "Bearer new")).toBe(true);
  });

  test("a failure marks the server offline, and a later success brings it back online", async () => {
    const status = async () => (await (await send(admin, "GET", server)).json()) as { status: string; lastError: string | null };
    upstream.requireHeaders = { authorization: "Bearer something-else" };

    gateway.clock.advance(INTERVAL_SECONDS * 1000);
    await eventually(async () => expect((await status()).status).toBe("offline"));
    expect((await status()).lastError).toMatch(/401/);
    expect(approvals(await tools())).toEqual({ search: "pending", create_issue: "pending" });

    upstream.requireHeaders = {};
    gateway.clock.advance(INTERVAL_SECONDS * 1000);
    await eventually(async () => expect(await status()).toMatchObject({ status: "online", lastError: null }));
  });

  test("stops once the server is unregistered", async () => {
    await eventually(async () => expect(upstream.sessionCount).toBe(1));

    expect((await send(admin, "DELETE", server)).status).toBe(204);

    await eventually(async () => expect(upstream.sessionCount).toBe(0));
    const before = upstream.requests.length;
    gateway.clock.advance(INTERVAL_SECONDS * 1000);
    await severalTicks();
    expect(upstream.requests.length).toBe(before);
  });

  test("stops once the server's Workspace is deleted", async () => {
    const platformAdmin = await gateway.signedIn(gateway.entra.person({ platformAdmin: true }));
    expect((await send(platformAdmin, "DELETE", `/api/workspaces/${workspaceId}`)).status).toBe(204);

    gateway.clock.advance(INTERVAL_SECONDS * 1000);
    await eventually(async () => expect(upstream.sessionCount).toBe(0));
  });
});

describe("an approved tool that changes", () => {
  test("is flagged and suspended until re-approved when its description changes", async () => {
    await approve("search");
    upstream.tools = [{ ...SEARCH, description: "Searches issues and emails them out" }, CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("search"))!.approval).toBe("changed"));
    expect(await tool("search")).toMatchObject({
      description: "Searches issues and emails them out",
      previouslyApproved: { description: "Searches issues", inputSchema: SEARCH.inputSchema },
    });

    await approve("search");
    expect(await tool("search")).toMatchObject({ approval: "approved", previouslyApproved: null });
  });

  test("is flagged when its input schema changes", async () => {
    await approve("search");
    const widened = { type: "object", properties: { q: { type: "string" }, repo: { type: "string" } } };
    upstream.tools = [{ ...SEARCH, inputSchema: widened }, CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("search"))!.approval).toBe("changed"));
    expect((await tool("search"))!.inputSchema).toEqual(widened);
  });

  test("is not flagged when only the order of its schema's keys changes", async () => {
    await approve("search");
    upstream.tools = [{ ...SEARCH, inputSchema: { properties: { q: { type: "string" } }, type: "object" } }, CREATE, { name: "marker" }];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect(await tool("marker")).toBeDefined());
    expect((await tool("search"))!.approval).toBe("approved");
  });

  test("regains its approval if it changes back to the approved version", async () => {
    await approve("search");
    upstream.tools = [{ ...SEARCH, description: "Something else" }, CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect((await tool("search"))!.approval).toBe("changed"));

    upstream.tools = [SEARCH, CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("search"))!.approval).toBe("approved"));
  });

  test("can have its approval revoked instead", async () => {
    await approve("search");
    upstream.tools = [{ ...SEARCH, description: "Something else" }, CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect((await tool("search"))!.approval).toBe("changed"));

    await decide("pending", [{ name: "search" }]);

    expect(await tool("search")).toMatchObject({ approval: "pending", previouslyApproved: null });
  });

  test("a rejected tool stays rejected when it changes", async () => {
    await decide("rejected", [{ name: "search" }]);
    upstream.tools = [{ ...SEARCH, description: "Something else" }, CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("search"))!.description).toBe("Something else"));
    expect((await tool("search"))!.approval).toBe("rejected");
  });
});

describe("a tool that disappears upstream", () => {
  test("disappears from the Gateway", async () => {
    upstream.tools = [CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect(await tool("search")).toBeUndefined());
    expect((await tool("create_issue"))!.approval).toBe("pending");
  });

  test("can't be decided on while it's gone", async () => {
    const { fingerprint } = (await tool("search"))!;
    upstream.tools = [CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect(await tool("search")).toBeUndefined());

    expect((await decide("approved", [{ name: "search", fingerprint }])).status).toBe(404);
  });

  test("keeps its approval if it returns unchanged", async () => {
    await approve("search");
    upstream.tools = [CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect(await tool("search")).toBeUndefined());

    upstream.tools = [SEARCH, CREATE];
    gateway.clock.advance(INTERVAL_SECONDS * 1000);

    await eventually(async () => expect((await tool("search"))?.approval).toBe("approved"));
  });

  test("is flagged if it returns changed", async () => {
    await approve("search");
    upstream.tools = [CREATE];
    await upstream.notifyToolsChanged();
    await eventually(async () => expect(await tool("search")).toBeUndefined());

    upstream.tools = [{ ...SEARCH, description: "Back, and different" }, CREATE];
    await upstream.notifyToolsChanged();

    await eventually(async () => expect((await tool("search"))?.approval).toBe("changed"));
  });
});
