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

export const ErrorResponse = z
  .object({
    error: z.string().openapi({ description: "Machine-readable error code", example: "unauthenticated" }),
    message: z.string(),
  })
  .openapi("ErrorResponse");
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const CurrentUser = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    name: z.string(),
    email: z.string(),
    isPlatformAdmin: z.boolean().openapi({ description: "Holds the Platform Admin app role as of the last sign-in" }),
  })
  .openapi("CurrentUser");
export type CurrentUser = z.infer<typeof CurrentUser>;

export const WorkspaceSummary = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    name: z.string(),
  })
  .openapi("WorkspaceSummary");
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const MeResponse = z
  .object({
    user: CurrentUser,
    workspaces: z.array(WorkspaceSummary).openapi({ description: "Workspaces the signed-in User belongs to" }),
  })
  .openapi("MeResponse");
export type MeResponse = z.infer<typeof MeResponse>;

/** Reasons the Web UI is sent back with `?sign_in_error=`. */
export const SignInError = z.enum(["other_tenant", "failed"]);
export type SignInError = z.infer<typeof SignInError>;
