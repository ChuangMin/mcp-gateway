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

/**
 * An in-test Upstream Server: a real MCP server over Streamable HTTP (stateless), at `url`. Tests change `tools`
 * and `requireHeaders` to simulate changes on the server, and read `requests` to see what the Gateway sent.
 */
export class FakeUpstream {
  tools: FakeTool[];
  requireHeaders: Record<string, string>;
  /** Headers of every HTTP request received, in order. */
  readonly requests: IncomingHttpHeaders[] = [];
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
      const server = upstream.#mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      server
        .connect(transport)
        .then(() => transport.handleRequest(req, res))
        .catch(() => res.headersSent || res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => upstream.#http.listen(0, "127.0.0.1", resolve));
    upstream.#url = `http://127.0.0.1:${(upstream.#http.address() as AddressInfo).port}/mcp`;
    return upstream;
  }

  /** The Streamable HTTP endpoint to register with the Gateway. */
  get url(): string {
    return this.#url;
  }

  /** Stops the server. Safe to call more than once. */
  close(): Promise<void> {
    if (!this.#http.listening) return Promise.resolve();
    this.#http.closeAllConnections();
    return new Promise((resolve, reject) => this.#http.close((err) => (err ? reject(err) : resolve())));
  }

  #mcpServer(): Server {
    const server = new Server({ name: "fake-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
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
