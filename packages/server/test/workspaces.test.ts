import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootGateway, type Browser, type EntraPerson, type TestGateway } from "./support/harness.js";

let gateway: TestGateway;
let platformAdmin: Browser;

beforeEach(async () => {
  gateway = await bootGateway();
  platformAdmin = await gateway.signedIn(gateway.entra.person({ name: "Pat Platform", platformAdmin: true }));
});
afterEach(async () => {
  await gateway.close();
});

function send(browser: Browser, method: string, path: string, body?: unknown): Promise<Response> {
  return browser.fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

/** Creates a Workspace as the Platform Admin and returns its id. */
async function createWorkspace(name: string, admins: EntraPerson[]): Promise<string> {
  const response = await send(platformAdmin, "POST", "/api/workspaces", { name, admins: admins.map((a) => a.email) });
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function me(browser: Browser) {
  return (await browser.fetch("/api/me")).json();
}

async function members(browser: Browser, workspaceId: string) {
  const response = await browser.fetch(`/api/workspaces/${workspaceId}/members`);
  expect(response.status).toBe(200);
  return (await response.json()).members as Array<{ user: { id: string; email: string }; standing: string }>;
}

async function userIdOf(browser: Browser): Promise<string> {
  return (await me(browser)).user.id;
}

describe("Workspace lifecycle (Platform Admin)", () => {
  test("creates a Workspace whose initial Workspace Admin may not have signed in yet", async () => {
    const ada = gateway.entra.person({ name: "Ada", email: "ada@example.test" });

    const response = await send(platformAdmin, "POST", "/api/workspaces", {
      name: "Data Platform",
      admins: ["ADA@example.test"],
    });

    expect(response.status).toBe(201);
    const workspace = await response.json();
    expect(workspace).toEqual({ id: expect.any(String), name: "Data Platform", createdAt: gateway.clock.now().toISOString() });
    const adaBrowser = await gateway.signedIn(ada);
    expect((await me(adaBrowser)).workspaces).toEqual([{ id: workspace.id, name: "Data Platform", standing: "admin" }]);
    expect(await members(adaBrowser, workspace.id)).toEqual([
      { user: { id: await userIdOf(adaBrowser), name: "Ada", email: "ada@example.test" }, standing: "admin" },
    ]);
  });

  test("lists every Workspace", async () => {
    await createWorkspace("Beta", [gateway.entra.person()]);
    await createWorkspace("alpha", [gateway.entra.person()]);

    const response = await platformAdmin.fetch("/api/workspaces");

    expect(response.status).toBe(200);
    expect((await response.json()).workspaces.map((w: { name: string }) => w.name)).toEqual(["alpha", "Beta"]);
  });

  test("a Workspace needs at least one initial Workspace Admin and a name", async () => {
    expect((await send(platformAdmin, "POST", "/api/workspaces", { name: "Empty", admins: [] })).status).toBe(400);
    const noName = await send(platformAdmin, "POST", "/api/workspaces", { name: "  ", admins: ["x@example.test"] });
    expect(noName.status).toBe(400);
    expect((await noName.json()).error).toBe("invalid_request");
  });

  test("initial Workspace Admins must be people in the Entra Tenant", async () => {
    const outsider = gateway.entra.person({ tenantId: randomUUID() });

    for (const admin of ["nobody@example.test", outsider.email]) {
      const response = await send(platformAdmin, "POST", "/api/workspaces", { name: "Ghosts", admins: [admin] });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe("person_not_found");
    }
    expect((await (await platformAdmin.fetch("/api/workspaces")).json()).workspaces).toEqual([]);
  });

  test("Workspace names are unique, ignoring case", async () => {
    await createWorkspace("Security", [gateway.entra.person()]);

    const response = await send(platformAdmin, "POST", "/api/workspaces", {
      name: "security",
      admins: [gateway.entra.person().email],
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("name_taken");
  });

  test("renames a Workspace", async () => {
    const admin = gateway.entra.person();
    const id = await createWorkspace("Old name", [admin]);
    await createWorkspace("Taken", [gateway.entra.person()]);

    const renamed = await send(platformAdmin, "PATCH", `/api/workspaces/${id}`, { name: "New name" });
    const clash = await send(platformAdmin, "PATCH", `/api/workspaces/${id}`, { name: "taken" });

    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("New name");
    expect(clash.status).toBe(409);
    expect((await me(await gateway.signedIn(admin))).workspaces[0].name).toBe("New name");
  });

  test("deletes a Workspace, and its members no longer belong to it", async () => {
    const admin = gateway.entra.person();
    const id = await createWorkspace("Doomed", [admin]);
    const adminBrowser = await gateway.signedIn(admin);

    const response = await send(platformAdmin, "DELETE", `/api/workspaces/${id}`);

    expect(response.status).toBe(204);
    expect((await me(adminBrowser)).workspaces).toEqual([]);
    expect((await adminBrowser.fetch(`/api/workspaces/${id}`)).status).toBe(404);
    expect((await send(platformAdmin, "DELETE", `/api/workspaces/${id}`)).status).toBe(404);
  });

  test("only a Platform Admin can list, create, rename or delete Workspaces, even a Workspace Admin cannot", async () => {
    const admin = gateway.entra.person();
    const id = await createWorkspace("Mine", [admin]);
    const workspaceAdmin = await gateway.signedIn(admin);

    const attempts = [
      await send(workspaceAdmin, "GET", "/api/workspaces"),
      await send(workspaceAdmin, "POST", "/api/workspaces", { name: "Another", admins: [admin.email] }),
      await send(workspaceAdmin, "PATCH", `/api/workspaces/${id}`, { name: "Renamed" }),
      await send(workspaceAdmin, "DELETE", `/api/workspaces/${id}`),
    ];

    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect((await me(workspaceAdmin)).workspaces).toEqual([{ id, name: "Mine", standing: "admin" }]);
  });

  test("reports Entra being unreachable instead of failing obscurely", async () => {
    gateway.entra.graphDown = true;

    const response = await send(platformAdmin, "POST", "/api/workspaces", {
      name: "Offline",
      admins: [gateway.entra.person().email],
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("entra_unavailable");
  });
});

describe("membership (Workspace Admin)", () => {
  let adminPerson: EntraPerson;
  let admin: Browser;
  let workspaceId: string;

  beforeEach(async () => {
    adminPerson = gateway.entra.person({ name: "Wanda Admin" });
    workspaceId = await createWorkspace("Payments", [adminPerson]);
    admin = await gateway.signedIn(adminPerson);
  });

  async function addMember(person: EntraPerson | string, standing?: string) {
    const ref = typeof person === "string" ? person : person.email;
    return send(admin, "POST", `/api/workspaces/${workspaceId}/members`, { person: ref, standing });
  }

  test("adds a person from the Entra Tenant as a member", async () => {
    const bob = gateway.entra.person({ name: "Bob", email: "bob@example.test" });

    const response = await addMember(bob);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      user: { id: expect.any(String), name: "Bob", email: "bob@example.test" },
      standing: "member",
    });
    expect((await me(await gateway.signedIn(bob))).workspaces).toEqual([
      { id: workspaceId, name: "Payments", standing: "member" },
    ]);
  });

  test("adds a person by Entra object ID", async () => {
    const bob = gateway.entra.person({ email: "bob@example.test" });

    const response = await addMember(bob.objectId);

    expect(response.status).toBe(201);
    expect((await response.json()).user.email).toBe("bob@example.test");
  });

  test("refuses people who are not in the Entra Tenant, and people already in the Workspace", async () => {
    const bob = gateway.entra.person();
    await addMember(bob);

    const unknown = await addMember("nobody@example.test");
    const outsider = await addMember(gateway.entra.person({ tenantId: randomUUID() }));
    const again = await addMember(bob);

    expect(unknown.status).toBe(422);
    expect(outsider.status).toBe(422);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_member");
  });

  test("removes a member, who then no longer belongs to the Workspace", async () => {
    const bob = gateway.entra.person();
    const bobId = (await (await addMember(bob)).json()).user.id;
    const bobBrowser = await gateway.signedIn(bob);

    const response = await send(admin, "DELETE", `/api/workspaces/${workspaceId}/members/${bobId}`);

    expect(response.status).toBe(204);
    expect((await me(bobBrowser)).workspaces).toEqual([]);
    expect((await bobBrowser.fetch(`/api/workspaces/${workspaceId}/members`)).status).toBe(404);
    expect((await send(admin, "DELETE", `/api/workspaces/${workspaceId}/members/${bobId}`)).status).toBe(404);
  });

  test("promotes a member to Workspace Admin and demotes them back", async () => {
    const bob = gateway.entra.person();
    const bobId = (await (await addMember(bob)).json()).user.id;
    const bobBrowser = await gateway.signedIn(bob);

    const promoted = await send(admin, "PATCH", `/api/workspaces/${workspaceId}/members/${bobId}`, { standing: "admin" });
    expect(promoted.status).toBe(204);
    expect((await me(bobBrowser)).workspaces[0].standing).toBe("admin");
    expect((await addMember(gateway.entra.person(), undefined)).status).toBe(201); // still works for the first admin
    expect((await send(bobBrowser, "POST", `/api/workspaces/${workspaceId}/members`, { person: gateway.entra.person().email })).status).toBe(201);

    const demoted = await send(admin, "PATCH", `/api/workspaces/${workspaceId}/members/${bobId}`, { standing: "member" });
    expect(demoted.status).toBe(204);
    expect((await me(bobBrowser)).workspaces[0].standing).toBe("member");
  });

  test("can add someone straight in as a Workspace Admin", async () => {
    const response = await addMember(gateway.entra.person(), "admin");

    expect((await response.json()).standing).toBe("admin");
  });

  describe("the last Workspace Admin", () => {
    test("cannot be demoted", async () => {
      const adminId = await userIdOf(admin);

      const response = await send(admin, "PATCH", `/api/workspaces/${workspaceId}/members/${adminId}`, {
        standing: "member",
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("last_workspace_admin");
      expect((await me(admin)).workspaces[0].standing).toBe("admin");
    });

    test("cannot be removed", async () => {
      const adminId = await userIdOf(admin);

      const response = await send(admin, "DELETE", `/api/workspaces/${workspaceId}/members/${adminId}`);

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("last_workspace_admin");
      expect((await me(admin)).workspaces).toHaveLength(1);
    });

    test("can step down once another Workspace Admin exists", async () => {
      await addMember(gateway.entra.person(), "admin");
      const adminId = await userIdOf(admin);

      const response = await send(admin, "DELETE", `/api/workspaces/${workspaceId}/members/${adminId}`);

      expect(response.status).toBe(204);
    });

    test("survives every Workspace Admin stepping down at the same moment", async () => {
      const others = [gateway.entra.person(), gateway.entra.person(), gateway.entra.person(), gateway.entra.person()];
      for (const person of others) await addMember(person, "admin");
      const browsers = [admin, ...(await Promise.all(others.map((p) => gateway.signedIn(p))))];
      const ids = await Promise.all(browsers.map(userIdOf));

      const results = await Promise.all(
        browsers.map((b, i) =>
          send(b, "PATCH", `/api/workspaces/${workspaceId}/members/${ids[i]}`, { standing: "member" }),
        ),
      );

      expect(results.filter((r) => r.status === 204)).toHaveLength(4);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      const standings = (await members(admin, workspaceId)).map((m) => m.standing);
      expect(standings.filter((s) => s === "admin")).toHaveLength(1);
    });
  });

  test("a member can see the Workspace and its members but cannot manage them", async () => {
    const bob = gateway.entra.person();
    await addMember(bob);
    const bobBrowser = await gateway.signedIn(bob);
    const adminId = await userIdOf(admin);

    expect(await (await bobBrowser.fetch(`/api/workspaces/${workspaceId}`)).json()).toEqual({
      id: workspaceId,
      name: "Payments",
      standing: "member",
    });
    expect(await members(bobBrowser, workspaceId)).toHaveLength(2);
    const attempts = [
      await send(bobBrowser, "POST", `/api/workspaces/${workspaceId}/members`, { person: gateway.entra.person().email }),
      await send(bobBrowser, "PATCH", `/api/workspaces/${workspaceId}/members/${adminId}`, { standing: "member" }),
      await send(bobBrowser, "DELETE", `/api/workspaces/${workspaceId}/members/${adminId}`),
      await send(bobBrowser, "PATCH", `/api/workspaces/${workspaceId}/members/${await userIdOf(bobBrowser)}`, {
        standing: "admin",
      }),
    ];
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  });

  test("a User may belong to several Workspaces with a different standing in each", async () => {
    const bob = gateway.entra.person();
    await addMember(bob);
    const otherId = await createWorkspace("Analytics", [bob]);

    const workspaces = (await me(await gateway.signedIn(bob))).workspaces;

    expect(workspaces).toEqual([
      { id: otherId, name: "Analytics", standing: "admin" },
      { id: workspaceId, name: "Payments", standing: "member" },
    ]);
  });

  describe("isolation between Workspaces", () => {
    let otherWorkspaceId: string;
    let otherAdminId: string;

    beforeEach(async () => {
      const otherAdmin = gateway.entra.person();
      otherWorkspaceId = await createWorkspace("Elsewhere", [otherAdmin]);
      otherAdminId = await userIdOf(await gateway.signedIn(otherAdmin));
    });

    test("a Workspace Admin cannot see or manage a Workspace they don't belong to", async () => {
      const base = `/api/workspaces/${otherWorkspaceId}`;
      const attempts = [
        await send(admin, "GET", base),
        await send(admin, "GET", `${base}/members`),
        await send(admin, "POST", `${base}/members`, { person: gateway.entra.person().email }),
        await send(admin, "PATCH", `${base}/members/${otherAdminId}`, { standing: "member" }),
        await send(admin, "DELETE", `${base}/members/${otherAdminId}`),
      ];

      expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    });

    test("a member of another Workspace cannot be managed through this one", async () => {
      const response = await send(admin, "DELETE", `/api/workspaces/${workspaceId}/members/${otherAdminId}`);

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("member_not_found");
    });

    test("a Platform Admin who isn't a member cannot see or manage a Workspace's members", async () => {
      const attempts = [
        await send(platformAdmin, "GET", `/api/workspaces/${workspaceId}/members`),
        await send(platformAdmin, "POST", `/api/workspaces/${workspaceId}/members`, {
          person: gateway.entra.person().email,
        }),
      ];

      expect(attempts.map((r) => r.status)).toEqual([404, 404]);
    });

    test("an unknown Workspace looks the same as someone else's", async () => {
      const response = await admin.fetch(`/api/workspaces/${randomUUID()}`);

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("workspace_not_found");
    });
  });
});

test("Workspace routes require a session", async () => {
  expect((await gateway.http("/api/workspaces")).status).toBe(401);
  expect((await gateway.http(`/api/workspaces/${randomUUID()}/members`)).status).toBe(401);
});
