import { expect } from "vitest";
import type { Browser, EntraPerson, TestGateway } from "./harness.js";

/** Sends a REST request, with a JSON body if one is given. */
export function send(browser: Browser, method: string, path: string, body?: unknown): Promise<Response> {
  return browser.fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

/** Creates a Workspace (as a fresh Platform Admin) whose Workspace Admin is a fresh person, signed in. */
export async function workspaceWithAdmin(gateway: TestGateway, name = `Workspace ${crypto.randomUUID().slice(0, 8)}`) {
  const platformAdmin = await gateway.signedIn(gateway.entra.person({ platformAdmin: true }));
  const adminPerson = gateway.entra.person();
  const response = await send(platformAdmin, "POST", "/api/workspaces", { name, admins: [adminPerson.email] });
  expect(response.status).toBe(201);
  const workspaceId: string = (await response.json()).id;
  return { workspaceId, adminPerson, admin: await gateway.signedIn(adminPerson), platformAdmin };
}

/** Adds a fresh person to the Workspace as a member and returns them signed in. */
export async function memberOf(gateway: TestGateway, admin: Browser, workspaceId: string): Promise<Browser> {
  const person: EntraPerson = gateway.entra.person();
  const response = await send(admin, "POST", `/api/workspaces/${workspaceId}/members`, { person: person.email });
  expect(response.status).toBe(201);
  return gateway.signedIn(person);
}
