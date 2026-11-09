import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootGateway, type TestGateway } from "./support/harness.js";

let gateway: TestGateway;
beforeEach(async () => {
  gateway = await bootGateway();
});
afterEach(async () => {
  await gateway.close();
});

const HOUR = 60 * 60 * 1000;

describe("signing in to the Web UI with Entra", () => {
  test("a person from the Entra Tenant is signed in and sent to the Web UI", async () => {
    const ada = gateway.entra.person({ name: "Ada Lovelace", email: "ada@example.test" });
    const browser = gateway.browser();

    const callback = await browser.signIn(ada);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    const me = await browser.fetch("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: expect.any(String), name: "Ada Lovelace", email: "ada@example.test", isPlatformAdmin: false },
      workspaces: [],
    });
  });

  test("starts an authorization code flow with PKCE at the configured tenant", async () => {
    const start = await gateway.browser().fetch("/auth/sign-in");

    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toMatch(/\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize$/);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("scope")?.split(" ")).toContain("openid");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://gateway.test/auth/callback");
  });

  test("the same Entra account is the same User across sign-ins, with name and email kept up to date", async () => {
    const ada = gateway.entra.person({ name: "Ada Byron" });
    const first = await (await (await gateway.signedIn(ada)).fetch("/api/me")).json();

    ada.name = "Ada Lovelace";
    const second = await (await (await gateway.signedIn(ada)).fetch("/api/me")).json();

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Ada Lovelace");
  });

  test("different Entra accounts are different Users", async () => {
    const a = await (await (await gateway.signedIn(gateway.entra.person())).fetch("/api/me")).json();
    const b = await (await (await gateway.signedIn(gateway.entra.person())).fetch("/api/me")).json();

    expect(a.user.id).not.toBe(b.user.id);
  });

  test("a person from another Entra tenant is rejected", async () => {
    const outsider = gateway.entra.person({ tenantId: randomUUID() });
    const browser = gateway.browser();

    const callback = await browser.signIn(outsider);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?sign_in_error=other_tenant");
    expect((await browser.fetch("/api/me")).status).toBe(401);
  });

  test("a sign-in Entra refuses comes back as a failed sign-in", async () => {
    const browser = gateway.browser();
    await browser.fetch("/auth/sign-in");
    const state = browser.cookie("mcpgw_sign_in")!;

    const callback = await browser.fetch(
      `/auth/callback?error=access_denied&error_description=denied&state=${encodeURIComponent(state)}`,
    );

    expect(callback.headers.get("location")).toBe("/?sign_in_error=failed");
    expect((await browser.fetch("/api/me")).status).toBe(401);
  });

  test("a callback that this browser did not start is rejected", async () => {
    // Login CSRF: an attacker's own authorization response delivered to a victim's browser.
    const attacker = gateway.browser();
    const start = await attacker.fetch("/auth/sign-in");
    const authorize = new URL(start.headers.get("location")!);
    authorize.searchParams.set("fake_person", gateway.entra.person().objectId);
    const atEntra = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(atEntra.headers.get("location")!);

    const victim = gateway.browser();
    const response = await victim.fetch(callback.pathname + callback.search);

    expect(response.headers.get("location")).toBe("/?sign_in_error=failed");
    expect((await victim.fetch("/api/me")).status).toBe(401);
  });

  test("an authorization response cannot be replayed", async () => {
    const browser = gateway.browser();
    const start = await browser.fetch("/auth/sign-in");
    const authorize = new URL(start.headers.get("location")!);
    authorize.searchParams.set("fake_person", gateway.entra.person().objectId);
    const callback = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!);
    const signInCookie = browser.cookie("mcpgw_sign_in")!;

    expect((await browser.fetch(callback.pathname + callback.search)).headers.get("location")).toBe("/");
    const replay = await gateway.http(callback.pathname + callback.search, {
      headers: { cookie: `mcpgw_sign_in=${signInCookie}` },
      redirect: "manual",
    });

    expect(replay.headers.get("location")).toBe("/?sign_in_error=failed");
    expect(replay.headers.getSetCookie().some((c) => c.startsWith("mcpgw_session=") && !/max-age=0/i.test(c))).toBe(
      false,
    );
  });

  test("an abandoned sign-in expires", async () => {
    const browser = gateway.browser();
    const start = await browser.fetch("/auth/sign-in");
    const authorize = new URL(start.headers.get("location")!);
    authorize.searchParams.set("fake_person", gateway.entra.person().objectId);
    const callback = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!);

    gateway.clock.advance(11 * 60 * 1000);
    const response = await browser.fetch(callback.pathname + callback.search);

    expect(response.headers.get("location")).toBe("/?sign_in_error=failed");
  });
});

describe("Platform Admin", () => {
  test("a person holding the Platform Admin app role is recognised as Platform Admin", async () => {
    const admin = gateway.entra.person({ platformAdmin: true });

    const me = await (await (await gateway.signedIn(admin)).fetch("/api/me")).json();

    expect(me.user.isPlatformAdmin).toBe(true);
  });

  test("losing the app role in Entra removes Platform Admin standing at the next sign-in", async () => {
    const admin = gateway.entra.person({ platformAdmin: true });
    await gateway.signedIn(admin);

    admin.platformAdmin = false;
    const me = await (await (await gateway.signedIn(admin)).fetch("/api/me")).json();

    expect(me.user.isPlatformAdmin).toBe(false);
  });
});

describe("the signed-in session", () => {
  test("REST API requests without a session are rejected", async () => {
    const response = await gateway.http("/api/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated", message: expect.any(String) });
  });

  test("REST API requests with an unknown session are rejected", async () => {
    const response = await gateway.http("/api/me", { headers: { cookie: "mcpgw_session=not-a-session" } });

    expect(response.status).toBe(401);
  });

  test("the session cookie is HttpOnly and SameSite=Lax", async () => {
    const browser = gateway.browser();
    const start = await browser.fetch("/auth/sign-in");
    const authorize = new URL(start.headers.get("location")!);
    authorize.searchParams.set("fake_person", gateway.entra.person().objectId);
    const callback = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!);

    const response = await browser.fetch(callback.pathname + callback.search);

    const session = response.headers.getSetCookie().find((c) => c.startsWith("mcpgw_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//i);
  });

  test("ends after 12 hours", async () => {
    const browser = await gateway.signedIn(gateway.entra.person());

    gateway.clock.advance(12 * HOUR - 1000);
    expect((await browser.fetch("/api/me")).status).toBe(200);
    gateway.clock.advance(1000);
    expect((await browser.fetch("/api/me")).status).toBe(401);
  });

  test("signing out ends the session, even for a copy of the cookie", async () => {
    const browser = await gateway.signedIn(gateway.entra.person());
    const copied = browser.cookie("mcpgw_session")!;

    const signOut = await browser.fetch("/auth/sign-out", { method: "POST" });

    expect(signOut.status).toBe(204);
    expect(browser.cookie("mcpgw_session")).toBeUndefined();
    expect((await browser.fetch("/api/me")).status).toBe(401);
    expect((await gateway.http("/api/me", { headers: { cookie: `mcpgw_session=${copied}` } })).status).toBe(401);
  });

  test("signing out without a session is harmless", async () => {
    const response = await gateway.http("/auth/sign-out", { method: "POST" });

    expect(response.status).toBe(204);
  });
});
