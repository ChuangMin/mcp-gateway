// The only way the Gateway reaches an Upstream Server: MCP over Streamable HTTP. There is deliberately no stdio
// transport and nothing here (or anywhere in the Gateway) launches a process (ADR 0001).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export interface DiscoveredTool {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** A live MCP session with one Upstream Server. */
export interface UpstreamSession {
  /** Lists every tool the server offers, following pagination. */
  listTools(): Promise<DiscoveredTool[]>;
  /** False once the connection has closed or failed; a new session is needed then. */
  readonly open: boolean;
  /** Ends the session, telling the server so. Never throws. */
  close(): Promise<void>;
}

export interface UpstreamConnector {
  /**
   * Opens an MCP session with an Upstream Server, sending `headers` on every request. `onToolsChanged` is called
   * whenever the server sends `notifications/tools/list_changed` (if it offers a stream to send it on).
   */
  connect(url: string, headers: Record<string, string>, onToolsChanged: () => void): Promise<UpstreamSession>;
}

const TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 100;

const CLIENT_INFO = { name: "mcp-gateway", version: "0.0.0" };

const MAX_ERROR_LENGTH = 500;

/** A readable reason for a failed connection: the HTTP status if there was one, and the network cause fetch hides. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  let message = error.message;
  if (error instanceof StreamableHTTPError && typeof error.code === "number" && error.code >= 100) {
    message = `HTTP ${error.code}: ${message}`;
  }
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  if (detail && !message.includes(detail)) message = `${message} (${detail})`;
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export function createUpstreamConnector(): UpstreamConnector {
  return {
    async connect(url, headers, onToolsChanged) {
      const client = new Client(CLIENT_INFO);
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        // A redirect could carry the Shared Credential's headers to another host. Stated explicitly rather than
        // relying on the SDK's default: only same-origin redirects, and none at all for the requests carrying messages.
        redirectPolicy: "same-origin",
        requestInit: { headers, redirect: "error" },
      });
      let open = true;
      client.onclose = () => {
        open = false;
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => onToolsChanged());

      const close = async () => {
        open = false;
        await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
      };

      try {
        await client.connect(transport, { timeout: TIMEOUT_MS });
      } catch (error) {
        await close();
        throw error;
      }

      return {
        get open() {
          return open;
        },
        close,
        async listTools() {
          const tools: DiscoveredTool[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_TOOL_PAGES; page++) {
            const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: TIMEOUT_MS });
            for (const tool of result.tools) {
              tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
            }
            cursor = result.nextCursor;
            if (cursor === undefined) break;
          }
          return tools;
        },
      };
    },
  };
}
