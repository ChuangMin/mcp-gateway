import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ErrorResponse,
  RegisterServerRequest,
  ReplaceCredentialRequest,
  UpdateServerRequest,
  UpstreamServer,
  UpstreamServerDetail,
  UpstreamServerList,
} from "../api/schemas.js";
import type { Directory } from "../directory/directory.js";
import { namespacedToolName } from "../naming.js";
import type { UpstreamServer as ServerRow, UpstreamRegistry, UpstreamTool as ToolRow } from "../upstream/registry.js";
import type { SessionEnv } from "./auth.js";
import { standingGuard } from "./authorize.js";
import { validationHook } from "./errors.js";

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const error = (description: string) => json(ErrorResponse, description);

const security = [{ session: [] }];
const WorkspaceParams = z.object({ workspaceId: z.uuid().openapi({ param: { name: "workspaceId", in: "path" } }) });
const ServerParams = WorkspaceParams.extend({ serverId: z.uuid().openapi({ param: { name: "serverId", in: "path" } }) });

const common = {
  400: error("The request is malformed"),
  401: error("No live Web UI session"),
  403: error("Only a Workspace Admin can do this"),
  404: error("No such Workspace or Upstream Server, or the signed-in User does not belong to the Workspace"),
};
const servers = "/api/workspaces/{workspaceId}/servers";

const listServers = createRoute({
  method: "get",
  path: servers,
  summary: "Lists the Workspace's Upstream Servers (any member)",
  security,
  request: { params: WorkspaceParams },
  responses: { 200: json(UpstreamServerList, "The Workspace's Upstream Servers"), ...common },
});

const registerServer = createRoute({
  method: "post",
  path: servers,
  summary: "Registers an Upstream Server and connects to it (Workspace Admin)",
  description:
    "The server is registered even when the first connection fails; `status` and `lastError` report the outcome.",
  security,
  request: { params: WorkspaceParams, body: jsonBody(RegisterServerRequest) },
  responses: {
    201: json(UpstreamServerDetail, "Registered, with the tools discovered on it (all pending Tool Approval)"),
    ...common,
    409: error("`prefix_taken`: the Workspace already has an Upstream Server with that prefix"),
  },
});

const getServer = createRoute({
  method: "get",
  path: `${servers}/{serverId}`,
  summary: "One Upstream Server and its discovered tools (any member)",
  security,
  request: { params: ServerParams },
  responses: { 200: json(UpstreamServerDetail, "The Upstream Server"), ...common },
});

const updateServer = createRoute({
  method: "patch",
  path: `${servers}/{serverId}`,
  summary: "Changes an Upstream Server's sensitive argument fields (Workspace Admin)",
  security,
  request: { params: ServerParams, body: jsonBody(UpdateServerRequest) },
  responses: { 200: json(UpstreamServer, "Updated"), ...common },
});

const replaceCredential = createRoute({
  method: "put",
  path: `${servers}/{serverId}/credential`,
  summary: "Replaces the Shared Credential and reconnects (Workspace Admin)",
  security,
  request: { params: ServerParams, body: jsonBody(ReplaceCredentialRequest) },
  responses: { 200: json(UpstreamServerDetail, "Replaced; `status` reports the reconnection"), ...common },
});

const unregisterServer = createRoute({
  method: "delete",
  path: `${servers}/{serverId}`,
  summary: "Unregisters an Upstream Server (Workspace Admin)",
  security,
  request: { params: ServerParams },
  responses: { 204: { description: "Unregistered" }, ...common },
});

const toServer = (s: ServerRow) => ({
  id: s.id,
  prefix: s.prefix,
  url: s.url,
  credential: { mode: s.credentialMode, headerNames: s.credentialHeaderNames },
  sensitiveFields: s.sensitiveFields,
  status: s.status,
  lastError: s.lastError,
  lastContactAt: s.lastContactAt?.toISOString() ?? null,
  createdAt: s.createdAt.toISOString(),
});

const toTool = (prefix: string, t: ToolRow) => ({
  name: t.name,
  namespacedName: namespacedToolName(prefix, t.name),
  description: t.description,
  inputSchema: t.inputSchema as Record<string, unknown>,
  approval: t.approval,
  discoveredAt: t.discoveredAt.toISOString(),
});

/** Upstream Server registration, scoped to one Workspace. Reads for members, changes for Workspace Admins. */
export function upstreamServerRoutes(directory: Directory, registry: UpstreamRegistry) {
  const app = new OpenAPIHono<SessionEnv>({ defaultHook: validationHook });
  const requireStanding = standingGuard(directory);

  const detail = async (server: ServerRow) => ({
    ...toServer(server),
    tools: (await registry.tools(server.id)).map((t) => toTool(server.prefix, t)),
  });

  app.openapi(listServers, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "member");
    return c.json({ servers: (await registry.list(workspaceId)).map(toServer) }, 200);
  });

  app.openapi(registerServer, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    return c.json(await detail(await registry.register(workspaceId, c.req.valid("json"))), 201);
  });

  app.openapi(getServer, async (c) => {
    const { workspaceId, serverId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "member");
    return c.json(await detail(await registry.get(workspaceId, serverId)), 200);
  });

  app.openapi(updateServer, async (c) => {
    const { workspaceId, serverId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    const { sensitiveFields } = c.req.valid("json");
    return c.json(toServer(await registry.setSensitiveFields(workspaceId, serverId, sensitiveFields)), 200);
  });

  app.openapi(replaceCredential, async (c) => {
    const { workspaceId, serverId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    const { headers } = c.req.valid("json");
    return c.json(await detail(await registry.replaceCredential(workspaceId, serverId, headers)), 200);
  });

  app.openapi(unregisterServer, async (c) => {
    const { workspaceId, serverId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    await registry.unregister(workspaceId, serverId);
    return c.body(null, 204);
  });

  return app;
}
