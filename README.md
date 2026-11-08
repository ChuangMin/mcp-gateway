# mcp-gateway

A self-hosted gateway that aggregates many MCP servers behind one endpoint and controls which teams and people inside one organization may use which tools. Sign-in goes through the organization's Microsoft Entra ID tenant.

Domain vocabulary: [`GLOSSARY.md`](GLOSSARY.md). Design decisions: [`docs/adr/`](docs/adr/). Architecture: [`docs/diagrams/architecture.html`](docs/diagrams/architecture.html).

> Status: walking skeleton. The Gateway starts, validates its configuration, migrates its database, answers `/health`, serves its OpenAPI document and an empty Web UI. Sign-in, Workspaces and tool calls arrive in later tickets.

## Run with Docker

Requires Docker with Compose.

```sh
cp .env.example .env    # then fill in ENCRYPTION_KEY and the ENTRA_* values
docker compose up --build
curl http://localhost:3000/health
```

`docker compose up` starts PostgreSQL and the Gateway. The Gateway waits for the database, applies migrations, and then reports healthy.

## Run locally

Requires Node.js 22+, pnpm 9, and a PostgreSQL you can reach. Without one, `pnpm --filter @mcp-gateway/server dev:db` runs a local PostgreSQL (no Docker) on port 54329 with `DATABASE_URL=postgres://gateway:gateway@127.0.0.1:54329/gateway`; stop it with Ctrl+C.

```sh
pnpm install
pnpm build                                 # builds the server and the web UI
export DATABASE_URL=postgres://gateway:gateway@localhost:5432/gateway
export PUBLIC_BASE_URL=http://localhost:3000
export ENCRYPTION_KEY=$(openssl rand -base64 32)
export ENTRA_TENANT_ID=... ENTRA_CLIENT_ID=... ENTRA_CLIENT_SECRET=...
pnpm --filter @mcp-gateway/server start
```

For development, run `pnpm dev` (server, with reload) and `pnpm --filter @mcp-gateway/web dev` (Vite, proxying to the server).

## Configuration

All configuration comes from environment variables; [`.env.example`](.env.example) lists them. The Gateway refuses to start, naming every problem, when a required value is missing or invalid.

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://` connection URL |
| `PUBLIC_BASE_URL` | yes | http(s) URL clients use to reach the Gateway |
| `ENCRYPTION_KEY` | yes | 32 bytes, base64; encrypts Upstream Server credentials at rest |
| `ENTRA_TENANT_ID` | yes | GUID of the one Entra Tenant this deployment trusts |
| `ENTRA_CLIENT_ID` | yes | GUID of the Gateway's Entra app registration |
| `ENTRA_CLIENT_SECRET` | yes | That app registration's client secret |
| `ENTRA_AUTHORITY_URL` | no | Default `https://login.microsoftonline.com` |
| `GRAPH_BASE_URL` | no | Default `https://graph.microsoft.com` |
| `PORT` / `HOST` | no | Default `3000` / `0.0.0.0` |
| `WEB_DIST_DIR` | no | Web UI build output; defaults to `packages/web/dist` |

## Database migrations

Migrations run **automatically on startup**. Applied migrations are skipped, so restarting is safe, and a PostgreSQL advisory lock means several Gateway instances starting together migrate once.

To add a migration, change `packages/server/src/db/schema.ts`, then run `pnpm --filter @mcp-gateway/server db:generate` and commit the generated files under `packages/server/drizzle/`.

## HTTP endpoints

- `GET /health`: `200` with `{"status":"ok","database":"reachable","time":…}`, or `503` when the database is unreachable
- `GET /openapi.json`: OpenAPI 3.1 document generated from the REST route definitions
- Everything else: the Web UI (paths without a file extension get `index.html`, so deep links work)

## Repository layout

```
packages/server   Node.js + Hono + Drizzle; the Gateway
packages/web      React + Vite; the Web UI (imports REST payload types from @mcp-gateway/server/api)
```

## Tests

```sh
pnpm test
```

Tests boot the whole Gateway in-process and drive it over HTTP (`packages/server/test/support/harness.ts`). Each test gets a fresh database in a real PostgreSQL that the test run downloads and starts itself through `embedded-postgres`, so Docker is not needed. Tests control time through an injectable clock (`TestClock`).

## License

[Apache-2.0](LICENSE)
