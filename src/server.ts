import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAuditLog } from "./audit";
import { createAuthenticator } from "./auth";
import { createRateLimiter } from "./policy";
import { createStore } from "./store";
import { registerTools } from "./tools";

export type AppOptions = {
  users: unknown; // validated in createAuthenticator
  orders: unknown; // validated in createStore
  auditPath: string;
  auditKey: string;
  rateLimit: { limit: number; windowMs: number };
};

const json = (status: number, body: object, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

// Returns a fetch handler for Bun.serve (or any Web-standard runtime).
export function createApp(options: AppOptions): (req: Request) => Promise<Response> {
  const authenticate = createAuthenticator(options.users);
  const deps = {
    store: createStore(options.orders),
    audit: createAuditLog(options.auditPath, options.auditKey),
    rateLimit: createRateLimiter(options.rateLimit.limit, options.rateLimit.windowMs),
  };

  return async (req) => {
    if (new URL(req.url).pathname !== "/mcp") return json(404, { error: "not_found" });

    // Browsers send Origin; MCP clients do not. Refusing it blocks cross-site
    // and DNS-rebinding requests, as the MCP Streamable HTTP spec requires.
    if (req.headers.has("origin")) return json(403, { error: "origin_not_allowed" });

    // Sign-in comes before anything else: no token, no MCP at all.
    const caller = authenticate(req.headers.get("authorization"));
    if (!caller) {
      return json(
        401,
        { error: "invalid_token", error_description: "Missing or unknown bearer token." },
        { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      );
    }

    // Stateless JSON mode: no sessions or server-sent streams, so only POST.
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });

    // A fresh MCP server per request, built for this caller only. The tools
    // close over the verified caller, so identity never comes from arguments.
    const server = new McpServer({ name: "mcp-guarded-server", version: "0.1.0" });
    registerTools(server, caller, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
