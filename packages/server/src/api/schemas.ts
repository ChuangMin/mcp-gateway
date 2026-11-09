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

export const Standing = z
  .enum(["admin", "member"])
  .openapi("Standing", { description: "`admin`: Workspace Admin. `member`: an ordinary member." });
export type Standing = z.infer<typeof Standing>;

export const WorkspaceSummary = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    name: z.string(),
    standing: Standing.openapi({ description: "The signed-in User's standing in this Workspace" }),
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

const WorkspaceName = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(100, "name must be at most 100 characters")
  .openapi({ example: "Platform Engineering" });

const Person = z
  .string()
  .trim()
  .min(1, "person must not be empty")
  .openapi({ description: "A person in the Entra Tenant: their email (user principal name) or Entra object ID", example: "ada@contoso.com" });

export const Workspace = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    name: z.string(),
    createdAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("Workspace");
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceList = z.object({ workspaces: z.array(Workspace) }).openapi("WorkspaceList");
export type WorkspaceList = z.infer<typeof WorkspaceList>;

export const CreateWorkspaceRequest = z
  .object({
    name: WorkspaceName,
    admins: z.array(Person).min(1, "a Workspace needs at least one initial Workspace Admin").openapi({
      description: "The initial Workspace Admins",
    }),
  })
  .openapi("CreateWorkspaceRequest");
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const RenameWorkspaceRequest = z.object({ name: WorkspaceName }).openapi("RenameWorkspaceRequest");
export type RenameWorkspaceRequest = z.infer<typeof RenameWorkspaceRequest>;

export const Member = z
  .object({
    user: z.object({ id: z.string().openapi({ format: "uuid" }), name: z.string(), email: z.string() }),
    standing: Standing,
  })
  .openapi("Member");
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ members: z.array(Member) }).openapi("MemberList");
export type MemberList = z.infer<typeof MemberList>;

export const AddMemberRequest = z
  .object({ person: Person, standing: Standing.default("member") })
  .openapi("AddMemberRequest");
export type AddMemberRequest = z.input<typeof AddMemberRequest>;

export const SetStandingRequest = z.object({ standing: Standing }).openapi("SetStandingRequest");
export type SetStandingRequest = z.infer<typeof SetStandingRequest>;
