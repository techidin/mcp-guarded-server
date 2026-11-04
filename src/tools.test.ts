// Guard failure paths, with the tools wired to stand-in dependencies that fail.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import orders from "../demo/orders.json";
import type { AuditEvent, AuditLog } from "./audit";
import { createStore, type Store } from "./store";
import { registerTools } from "./tools";

const GENERIC = [{ type: "text" as const, text: "The tool failed on the server." }];

const stderr = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => stderr.mockClear());

async function connect(store: Store, audit: AuditLog) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server, { userId: "ana", tenantId: "tenant-a", role: "viewer" }, { store, audit, rateLimit: () => 0 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown>) =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

describe("failures inside a tool", () => {
  test("return a generic error, never the internal message, and are still audited", async () => {
    const events: AuditEvent[] = [];
    const failing: Store = {
      ...createStore(orders),
      get: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      },
    };
    const call = await connect(failing, async (event) => {
      events.push(event);
    });

    const result = await call("get_order", { orderId: "o-1001" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(GENERIC);
    expect(events.map((e) => [e.tool, e.decision, e.reason])).toEqual([["get_order", "refused", "internal_error"]]);
    // Operators still see the cause, on the server's stderr.
    expect(String(stderr.mock.calls[0])).toContain("ECONNREFUSED");
  });

  test("a failed audit write returns no data: no trail, no result", async () => {
    const call = await connect(createStore(orders), async () => {
      throw new Error("EACCES: permission denied, open '/var/log/mcp/audit.log'");
    });

    const result = await call("get_order", { orderId: "o-1001" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(GENERIC);
    expect(String(stderr.mock.calls[0])).toContain("EACCES");
  });
});
