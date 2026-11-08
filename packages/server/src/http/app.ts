import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { HealthResponse } from "../api/schemas.js";
import { webUiHandler } from "./web-ui.js";

export interface AppDeps {
  clock: Clock;
  database: Database;
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

export function createApp({ clock, database, webDistDir }: AppDeps) {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, async (c) => {
    const time = clock.now().toISOString();
    if (await database.isReachable()) {
      return c.json({ status: "ok" as const, database: "reachable" as const, time }, 200);
    }
    return c.json({ status: "degraded" as const, database: "unreachable" as const, time }, 503);
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "mcp-gateway", version: "0.0.0" },
  });

  // Registered last: anything the REST routes did not claim belongs to the Web UI.
  app.get("*", webUiHandler(webDistDir));

  return app;
}
