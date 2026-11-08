// REST payload schemas. The server validates and documents with them; the web app imports the inferred types.
import { z } from "@hono/zod-openapi";

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    database: z.enum(["reachable", "unreachable"]),
    time: z.string().openapi({ format: "date-time" }),
  })
  .openapi("HealthResponse");
export type HealthResponse = z.infer<typeof HealthResponse>;
