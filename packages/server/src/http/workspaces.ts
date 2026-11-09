import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AddMemberRequest,
  CreateWorkspaceRequest,
  ErrorResponse,
  Member,
  MemberList,
  RenameWorkspaceRequest,
  SetStandingRequest,
  Workspace,
  WorkspaceList,
  WorkspaceSummary,
} from "../api/schemas.js";
import type { Directory, Workspace as WorkspaceRow } from "../directory/directory.js";
import type { SessionEnv } from "./auth.js";
import { requirePlatformAdmin, standingGuard, workspaceNotFound } from "./authorize.js";
import { validationHook } from "./errors.js";

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const error = (description: string) => json(ErrorResponse, description);

const security = [{ session: [] }];
const WorkspaceParams = z.object({ workspaceId: z.uuid().openapi({ param: { name: "workspaceId", in: "path" } }) });
const MemberParams = WorkspaceParams.extend({ userId: z.uuid().openapi({ param: { name: "userId", in: "path" } }) });

const common = {
  400: error("The request is malformed"),
  401: error("No live Web UI session"),
  403: error("The signed-in User's standing does not allow this"),
};

const listWorkspaces = createRoute({
  method: "get",
  path: "/api/workspaces",
  summary: "Lists every Workspace (Platform Admin)",
  security,
  responses: { 200: json(WorkspaceList, "All Workspaces"), ...common },
});

const createWorkspace = createRoute({
  method: "post",
  path: "/api/workspaces",
  summary: "Creates a Workspace with its initial Workspace Admins (Platform Admin)",
  security,
  request: { body: jsonBody(CreateWorkspaceRequest) },
  responses: {
    201: json(Workspace, "Created"),
    ...common,
    409: error("`name_taken`: another Workspace has that name"),
    422: error("`person_not_found`: an initial Workspace Admin is not in the Entra Tenant"),
    502: error("`entra_unavailable`: Microsoft Graph could not be reached"),
  },
});

const renameWorkspace = createRoute({
  method: "patch",
  path: "/api/workspaces/{workspaceId}",
  summary: "Renames a Workspace (Platform Admin)",
  security,
  request: { params: WorkspaceParams, body: jsonBody(RenameWorkspaceRequest) },
  responses: {
    200: json(Workspace, "Renamed"),
    ...common,
    404: error("No such Workspace"),
    409: error("`name_taken`: another Workspace has that name"),
  },
});

const deleteWorkspace = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}",
  summary: "Deletes a Workspace (Platform Admin)",
  security,
  request: { params: WorkspaceParams },
  responses: { 204: { description: "Deleted" }, ...common, 404: error("No such Workspace") },
});

const getWorkspace = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}",
  summary: "One Workspace the signed-in User belongs to",
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: json(WorkspaceSummary, "The Workspace and the signed-in User's standing in it"),
    ...common,
    404: error("No such Workspace, or the signed-in User does not belong to it"),
  },
});

const listMembers = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/members",
  summary: "Lists a Workspace's members (any member)",
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: json(MemberList, "Members and their standing"),
    ...common,
    404: error("No such Workspace, or the signed-in User does not belong to it"),
  },
});

const addMember = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/members",
  summary: "Adds a person from the Entra Tenant to the Workspace (Workspace Admin)",
  security,
  request: { params: WorkspaceParams, body: jsonBody(AddMemberRequest) },
  responses: {
    201: json(Member, "Added"),
    ...common,
    404: error("No such Workspace, or the signed-in User does not belong to it"),
    409: error("`already_member`: the person already belongs to the Workspace"),
    422: error("`person_not_found`: the person is not in the Entra Tenant"),
    502: error("`entra_unavailable`: Microsoft Graph could not be reached"),
  },
});

const setStanding = createRoute({
  method: "patch",
  path: "/api/workspaces/{workspaceId}/members/{userId}",
  summary: "Promotes a member to Workspace Admin or demotes them (Workspace Admin)",
  security,
  request: { params: MemberParams, body: jsonBody(SetStandingRequest) },
  responses: {
    204: { description: "Changed" },
    ...common,
    404: error("No such Workspace or member"),
    409: error("`last_workspace_admin`: the Workspace would be left without a Workspace Admin"),
  },
});

const removeMember = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}/members/{userId}",
  summary: "Removes a member from the Workspace (Workspace Admin)",
  security,
  request: { params: MemberParams },
  responses: {
    204: { description: "Removed" },
    ...common,
    404: error("No such Workspace or member"),
    409: error("`last_workspace_admin`: the Workspace would be left without a Workspace Admin"),
  },
});

const toWorkspace = (w: WorkspaceRow) => ({ id: w.id, name: w.name, createdAt: w.createdAt.toISOString() });

/** Workspace lifecycle (Platform Admin) and membership (by standing in the Workspace). */
export function workspaceRoutes(directory: Directory) {
  const app = new OpenAPIHono<SessionEnv>({ defaultHook: validationHook });

  const requireStanding = standingGuard(directory);

  app.openapi(listWorkspaces, async (c) => {
    requirePlatformAdmin(c);
    return c.json({ workspaces: (await directory.listWorkspaces()).map(toWorkspace) }, 200);
  });

  app.openapi(createWorkspace, async (c) => {
    requirePlatformAdmin(c);
    const { name, admins } = c.req.valid("json");
    return c.json(toWorkspace(await directory.createWorkspace(name, admins)), 201);
  });

  app.openapi(renameWorkspace, async (c) => {
    requirePlatformAdmin(c);
    const { workspaceId } = c.req.valid("param");
    return c.json(toWorkspace(await directory.renameWorkspace(workspaceId, c.req.valid("json").name)), 200);
  });

  app.openapi(deleteWorkspace, async (c) => {
    requirePlatformAdmin(c);
    await directory.deleteWorkspace(c.req.valid("param").workspaceId);
    return c.body(null, 204);
  });

  app.openapi(getWorkspace, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const standing = await requireStanding(c, workspaceId, "member");
    const workspace = await directory.findWorkspace(workspaceId);
    if (!workspace) throw workspaceNotFound();
    return c.json({ id: workspace.id, name: workspace.name, standing }, 200);
  });

  app.openapi(listMembers, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "member");
    return c.json({ members: await directory.members(workspaceId) }, 200);
  });

  app.openapi(addMember, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    const { person, standing } = c.req.valid("json");
    return c.json(await directory.addMember(workspaceId, person, standing), 201);
  });

  app.openapi(setStanding, async (c) => {
    const { workspaceId, userId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    await directory.setStanding(workspaceId, userId, c.req.valid("json").standing);
    return c.body(null, 204);
  });

  app.openapi(removeMember, async (c) => {
    const { workspaceId, userId } = c.req.valid("param");
    await requireStanding(c, workspaceId, "admin");
    await directory.removeMember(workspaceId, userId);
    return c.body(null, 204);
  });

  return app;
}
