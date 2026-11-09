import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { SignInError } from "../api/schemas.js";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import { recordSignIn, type User } from "../directory/users.js";
import type { Identity } from "../identity/identity.js";
import { WEB_SESSION_LIFETIME_MS, type WebSessions } from "../web-sessions.js";

export const SESSION_COOKIE = "mcpgw_session";
/** Binds an in-progress sign-in to the browser that started it, so a stolen authorization response is useless. */
const SIGN_IN_COOKIE = "mcpgw_sign_in";

/** Hono variables available to handlers behind `requireSession`. */
export type SessionEnv = { Variables: { user: User } };

export interface AuthDeps {
  config: Config;
  clock: Clock;
  database: Database;
  identity: Identity;
  sessions: WebSessions;
}

/** Web UI sign-in through Entra and sign-out. These are browser navigations, not REST API calls. */
export function authRoutes({ config, clock, database, identity, sessions }: AuthDeps) {
  const app = new Hono();
  const redirectUri = new URL("/auth/callback", config.publicBaseUrl).toString();
  const cookie: CookieOptions = {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.publicBaseUrl.protocol === "https:",
    path: "/",
  };
  const signInCookie: CookieOptions = { ...cookie, path: "/auth", maxAge: 10 * 60 };

  app.get("/auth/sign-in", async (c) => {
    const { authorizationUrl, state } = await identity.beginSignIn(redirectUri);
    setCookie(c, SIGN_IN_COOKIE, state, signInCookie);
    return c.redirect(authorizationUrl, 302);
  });

  app.get("/auth/callback", async (c) => {
    const backToWebUi = (error: SignInError) => c.redirect(`/?sign_in_error=${error}`, 302);
    const state = c.req.query("state");
    const expected = getCookie(c, SIGN_IN_COOKIE);
    deleteCookie(c, SIGN_IN_COOKIE, signInCookie);
    if (state === undefined || expected === undefined || state !== expected) {
      console.warn("Web UI sign-in failed: the callback's state does not match this browser's sign-in");
      return backToWebUi("failed");
    }

    const code = c.req.query("error") === undefined ? c.req.query("code") : undefined;
    const outcome = await identity.completeSignIn(state, code);
    if (!outcome.ok) {
      console.warn(`Web UI sign-in failed (${outcome.reason}): ${outcome.detail}`);
      return backToWebUi(outcome.reason);
    }

    const user = await recordSignIn(database, outcome.identity, clock.now());
    const token = await sessions.create(user);
    setCookie(c, SESSION_COOKIE, token, { ...cookie, maxAge: WEB_SESSION_LIFETIME_MS / 1000 });
    return c.redirect("/", 302);
  });

  app.post("/auth/sign-out", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) await sessions.end(token);
    deleteCookie(c, SESSION_COOKIE, cookie);
    return c.body(null, 204);
  });

  return app;
}

/** Rejects requests that carry no live Web UI session; otherwise puts the signed-in User in `c.var.user`. */
export function requireSession(sessions: WebSessions): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? undefined : await sessions.find(token);
    if (user === undefined) {
      return c.json({ error: "unauthenticated", message: "Sign in to use the REST API" }, 401);
    }
    c.set("user", user);
    await next();
  };
}
