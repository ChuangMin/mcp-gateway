import { ConfigError } from "./config.js";
import { startGateway } from "./gateway.js";

function port(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError([`PORT must be an integer between 1 and 65535`]);
  }
  return parsed;
}

try {
  const gateway = await startGateway({
    env: process.env,
    port: port(process.env.PORT),
    hostname: process.env.HOST || "0.0.0.0",
    webDistDir: process.env.WEB_DIST_DIR || undefined,
  });
  console.log(`mcp-gateway listening on ${gateway.url}`);

  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
