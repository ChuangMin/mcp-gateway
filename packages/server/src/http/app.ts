import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import type { Identity } from "../identity/identity.js";
import type { WebSessions } from "../web-sessions.js";
import { ErrorResponse, HealthResponse, MeResponse } from "../api/schemas.js";
import { SESSION_COOKIE, authRoutes, requireSession, type SessionEnv } from "./auth.js";
import { webUiHandler } from "./web-ui.js";

export interface AppDeps {
  config: Config;
  clock: Clock;
  database: Database;
  identity: Identity;
  sessions: WebSessions;
  /** Directory holding the web package's build output. */
  webDistDir: string;
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Reports whether the Gateway and its database are reachable",
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } },
    503: { description: "The database is unreachable", content: { "application/json": { schema: HealthResponse } } },
  },
});

const unauthenticated = {
  401: { description: "No live Web UI session", content: { "application/json": { schema: ErrorResponse } } },
} as const;

const meRoute = createRoute({
  method: "get",
  path: "/api/me",
  summary: "Who is signed in, and the Workspaces they belong to",
  security: [{ session: [] }],
  responses: {
    200: { description: "The signed-in User", content: { "application/json": { schema: MeResponse } } },
    ...unauthenticated,
  },
});

export function createApp(deps: AppDeps) {
  const { clock, database, sessions, webDistDir } = deps;
  const app = new OpenAPIHono<SessionEnv>();

  app.openapi(healthRoute, async (c) => {
    const time = clock.now().toISOString();
    if (await database.isReachable()) {
      return c.json({ status: "ok" as const, database: "reachable" as const, time }, 200);
    }
    return c.json({ status: "degraded" as const, database: "unreachable" as const, time }, 503);
  });

  app.route("/", authRoutes(deps));

  // Every REST API route needs a signed-in session.
  app.use("/api/*", requireSession(sessions));

  app.openapi(meRoute, (c) => {
    const { id, name, email, isPlatformAdmin } = c.var.user;
    // Workspace membership arrives with Workspaces (#4); until then nobody belongs to one.
    return c.json({ user: { id, name, email, isPlatformAdmin }, workspaces: [] }, 200);
  });

  app.all("/api/*", (c) => c.json({ error: "not_found", message: "No such REST API route" }, 404));

  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE,
    description: "The Web UI session cookie, set by signing in at /auth/sign-in",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "mcp-gateway", version: "0.0.0" },
  });

  // Registered last: anything the REST routes did not claim belongs to the Web UI.
  app.get("*", webUiHandler(webDistDir));

  return app;
}
