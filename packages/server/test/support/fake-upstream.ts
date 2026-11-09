import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface FakeUpstreamOptions {
  /** Headers every request must carry (names case-insensitive); otherwise it answers 401. */
  requireHeaders?: Record<string, string>;
  tools?: FakeTool[];
}

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * An in-test Upstream Server: a real MCP server over Streamable HTTP, at `url`. It keeps a session per client, so
 * it can tell connected clients its tool list changed. Tests change `tools` and `requireHeaders` to simulate
 * changes on the server, and read `requests` to see what the Gateway sent.
 */
export class FakeUpstream {
  tools: FakeTool[];
  requireHeaders: Record<string, string>;
  /** Headers of every HTTP request received, in order. */
  readonly requests: IncomingHttpHeaders[] = [];
  readonly #sessions = new Map<string, Session>();
  #http!: HttpServer;
  #url = "";

  private constructor(options: FakeUpstreamOptions) {
    this.tools = options.tools ?? [];
    this.requireHeaders = options.requireHeaders ?? {};
  }

  static async start(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
    const upstream = new FakeUpstream(options);
    upstream.#http = createServer((req, res) => {
      upstream.requests.push(req.headers);
      for (const [name, value] of Object.entries(upstream.requireHeaders)) {
        if (req.headers[name.toLowerCase()] !== value) {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      upstream.#handle(req, res).catch(() => res.headersSent || res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => upstream.#http.listen(0, "127.0.0.1", resolve));
    upstream.#url = `http://127.0.0.1:${(upstream.#http.address() as AddressInfo).port}/mcp`;
    return upstream;
  }

  /** The Streamable HTTP endpoint to register with the Gateway. */
  get url(): string {
    return this.#url;
  }

  /** How many clients currently hold a session. */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Sends `notifications/tools/list_changed` to every connected client. */
  async notifyToolsChanged(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.server.sendToolListChanged()));
  }

  /** Stops the server. Safe to call more than once. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.server.close()));
    this.#sessions.clear();
    if (!this.#http.listening) return;
    this.#http.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.#http.close((err) => (err ? reject(err) : resolve())));
  }

  async #handle(req: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0], res: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1]) {
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? this.#sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }
    if (sessionId !== undefined) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    const server = this.#mcpServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => void this.#sessions.set(id, { server, transport }),
    });
    transport.onclose = () => {
      if (transport.sessionId) this.#sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  #mcpServer(): Server {
    const server = new Server(
      { name: "fake-upstream", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema ?? { type: "object" },
      })),
    }));
    return server;
  }
}
