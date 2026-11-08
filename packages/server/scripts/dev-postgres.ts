// Runs a local PostgreSQL for development, without Docker. Data persists in packages/server/.pg-dev/.
// Usage: pnpm --filter @mcp-gateway/server dev:db   (Ctrl+C to stop)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.DEV_PG_PORT ?? 54329);
const databaseDir = fileURLToPath(new URL("../.pg-dev", import.meta.url));
const firstRun = !existsSync(databaseDir);

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user: "gateway",
  password: "gateway",
  persistent: true,
  onLog: () => {},
});

if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase("gateway");

console.log(`PostgreSQL ready: DATABASE_URL=postgres://gateway:gateway@127.0.0.1:${port}/gateway`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
