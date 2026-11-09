// REST payload schemas. The server validates and documents with them; the web app imports the inferred types.
import { z } from "@hono/zod-openapi";
import { SERVER_PREFIX_MAX_LENGTH, SERVER_PREFIX_PATTERN } from "../naming.js";

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

// ---- Upstream Servers ----


/** Headers the Gateway sets itself when speaking MCP; a Shared Credential cannot override them. */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const CredentialHeader = z
  .strictObject({
    name: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "header name must be a valid HTTP header name")
      .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "the Gateway sets this header itself"),
    value: z
      .string()
      .min(1, "header value must not be empty")
      .max(8192, "header value must be at most 8192 characters")
      .refine((value) => !/[\r\n\0]/.test(value), "header value must not contain line breaks"),
  })
  .openapi("CredentialHeader", { example: { name: "Authorization", value: "Bearer s3cr3t" } });
export type CredentialHeader = z.infer<typeof CredentialHeader>;

const CredentialHeaders = z
  .array(CredentialHeader)
  .max(20)
  .refine(
    (headers) => new Set(headers.map((h) => h.name.toLowerCase())).size === headers.length,
    "each header may appear only once",
  )
  .openapi({ description: "The Shared Credential: fixed HTTP headers sent on every request to the Upstream Server" });

const SensitiveFields = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .openapi({
    description: "Argument field names to mask in Audit Records, on top of the built-in defaults",
    example: ["accountNumber"],
  });

export const ServerPrefix = z
  .string()
  .min(1, "prefix must not be empty")
  .max(SERVER_PREFIX_MAX_LENGTH, `prefix must be at most ${SERVER_PREFIX_MAX_LENGTH} characters`)
  .regex(
    SERVER_PREFIX_PATTERN,
    "prefix may contain only lowercase letters, digits and single underscores, and may not start or end with one",
  )
  .openapi({ example: "github" });

export const RegisterServerRequest = z
  .strictObject({
    prefix: ServerPrefix,
    url: z
      .string()
      .trim()
      .refine((value) => URL.canParse(value), "url must be a URL")
      .refine((value) => {
        if (!URL.canParse(value)) return true;
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      }, "url must be an http or https URL of a Streamable HTTP MCP server; the Gateway never launches commands")
      .refine((value) => {
        if (!URL.canParse(value)) return true;
        const { username, password } = new URL(value);
        return username === "" && password === "";
      }, "url must not contain credentials; put them in the Shared Credential headers")
      .openapi({ example: "https://mcp.example.com/mcp" }),
    headers: CredentialHeaders.default([]),
    sensitiveFields: SensitiveFields.default([]),
  })
  .openapi("RegisterServerRequest");
export type RegisterServerRequest = z.input<typeof RegisterServerRequest>;

export const ReplaceCredentialRequest = z
  .strictObject({ headers: CredentialHeaders })
  .openapi("ReplaceCredentialRequest");
export type ReplaceCredentialRequest = z.infer<typeof ReplaceCredentialRequest>;

export const UpdateServerRequest = z
  .strictObject({ sensitiveFields: SensitiveFields })
  .openapi("UpdateServerRequest", { description: "The Server Prefix and URL cannot be changed" });
export type UpdateServerRequest = z.infer<typeof UpdateServerRequest>;

export const UpstreamServer = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    prefix: z.string(),
    url: z.string(),
    credential: z.object({
      mode: z.enum(["shared", "personal"]),
      headerNames: z.array(z.string()).openapi({ description: "Names of the Shared Credential's headers; values are never returned" }),
    }),
    sensitiveFields: z.array(z.string()),
    status: z.enum(["online", "offline"]),
    lastError: z.string().nullable().openapi({ description: "Why the last connection attempt failed, if it did" }),
    lastContactAt: z.string().nullable().openapi({ format: "date-time", description: "Last successful contact" }),
    createdAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("UpstreamServer");
export type UpstreamServer = z.infer<typeof UpstreamServer>;

export const ToolApproval = z.enum(["pending", "approved"]).openapi("ToolApproval");
export type ToolApproval = z.infer<typeof ToolApproval>;

export const UpstreamTool = z
  .object({
    name: z.string().openapi({ description: "The tool's original name on the Upstream Server" }),
    namespacedName: z.string().openapi({ example: "github__search" }),
    description: z.string().nullable(),
    inputSchema: z.record(z.string(), z.unknown()),
    approval: ToolApproval,
    discoveredAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("UpstreamTool");
export type UpstreamTool = z.infer<typeof UpstreamTool>;

export const UpstreamServerDetail = UpstreamServer.extend({ tools: z.array(UpstreamTool) }).openapi(
  "UpstreamServerDetail",
);
export type UpstreamServerDetail = z.infer<typeof UpstreamServerDetail>;

export const UpstreamServerList = z.object({ servers: z.array(UpstreamServer) }).openapi("UpstreamServerList");
export type UpstreamServerList = z.infer<typeof UpstreamServerList>;
