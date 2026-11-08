# mcp-gateway

A self-hosted gateway that aggregates many MCP servers behind one endpoint and controls which teams and people inside one organization may use which tools.

## Language

**Gateway**:
The single MCP endpoint that clients connect to; it presents the combined capabilities of many Upstream Servers as one.
_Avoid_: Proxy, hub, router

**Upstream Server**:
An MCP server that sits behind the Gateway and whose capabilities the Gateway aggregates. Each one is registered by a Workspace and belongs to that Workspace.
_Avoid_: Backend, downstream server, provider

## Organization

**Entra Tenant**:
The one Microsoft Entra ID directory a Gateway deployment trusts for sign-in; it represents the whole organization running the deployment.
_Avoid_: Tenant (unqualified), directory, org

**Workspace**:
A team or department inside the organization; it owns its Upstream Servers and Roles, isolated from other Workspaces.
_Avoid_: Tenant, team, project, org

**User**:
A person from the Entra Tenant who belongs to one or more Workspaces and connects to the Gateway through an MCP client.
_Avoid_: Member, account, client

**Workspace Admin**:
A User who may change their Workspace's configuration: register Upstream Servers, set Tool Aliases, and manage Roles.
_Avoid_: Owner, manager, tenant admin

**Platform Admin**:
A person who operates the Gateway deployment as a whole and creates Workspaces; not tied to any one Workspace.
_Avoid_: Superuser, root, operator

## Access

**Role**:
A named set of tool permissions within a Workspace; Users are assigned Roles, and may call a tool only if one of their Roles allows it.
_Avoid_: Group, permission set, policy

**Shared Credential**:
A credential for an Upstream Server that the Workspace provides once and every User's calls use.
_Avoid_: Service account, global token

**Personal Credential**:
A credential for an Upstream Server that each User provides for themselves, so calls act as that User.
_Avoid_: User token, own token

**Profile**:
A User's chosen subset of a Workspace's Upstream Servers, reached at its own Gateway URL; one connection uses exactly one Profile, and therefore exactly one Workspace.
_Avoid_: Bundle, preset, collection, endpoint

**API Token**:
A token a User creates in the Gateway for one Profile, with an expiry of at most 90 days, for clients that cannot sign in through OAuth.
_Avoid_: Personal access token, API key, secret

**Audit Record**:
The Gateway's record of one tool call: who made it, in which Workspace, which tool, with what arguments (sensitive fields masked), the outcome, and how long it took.
_Avoid_: Log entry, event, trace

## Tools

**Server Prefix**:
The short name a Workspace Admin gives an Upstream Server when registering it, unique within the Workspace and fixed once in use.
_Avoid_: Namespace, slug, server name

**Namespaced Tool Name**:
The name the Gateway exposes for an Upstream Server's tool: the Server Prefix, two underscores, then the original tool name (e.g. `github__search`).
_Avoid_: Full name, qualified name

**Tool Approval**:
A Workspace Admin's decision to expose a tool newly discovered on an Upstream Server; until approved, no Role grants it, not even through a wildcard.
_Avoid_: Whitelisting, enablement

**Tool Alias**:
A name a Workspace assigns to replace a Namespaced Tool Name within that Workspace; the original name is no longer exposed.
_Avoid_: Nickname, rename
