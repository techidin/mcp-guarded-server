// End-to-end tests: a real MCP client talks to the app over Streamable HTTP.
// The client's fetch calls the app directly, so no port is opened.
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import orders from "../demo/orders.json";
import users from "../demo/users.json";
import { createApp } from "./server";

const ANA = "demo-ana-viewer-token"; // tenant-a, viewer
const BEN = "demo-ben-editor-token"; // tenant-a, editor
const MCP_URL = "http://localhost/mcp";

const auditFiles: string[] = [];
afterEach(async () => {
  await Promise.all(auditFiles.splice(0).map((f) => rm(f, { force: true })));
});

function setup(rateLimit = { limit: 100, windowMs: 60_000 }) {
  const auditPath = join(tmpdir(), `mcp-audit-${crypto.randomUUID()}.log`);
  auditFiles.push(auditPath);
  const app = createApp({ users, orders, auditPath, auditKey: "test-key", rateLimit });

  async function connect(token: string) {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => app(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return {
      async call(name: string, args: Record<string, unknown> = {}) {
        const raw = await client.callTool({ name, arguments: args });
        const result = CallToolResultSchema.parse(raw);
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        return { text, isError: result.isError === true };
      },
    };
  }

  async function auditLines(): Promise<Record<string, unknown>[]> {
    const file = Bun.file(auditPath);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  return { app, connect, auditLines, auditPath };
}

// Pulls the JSON payload out of the <untrusted-data> wrapper.
function dataOf(text: string): unknown {
  const match = text.match(/<untrusted-data[^>]*>\n([\s\S]*)\n<\/untrusted-data>$/);
  if (!match?.[1]) throw new Error(`no untrusted-data block in: ${text}`);
  return JSON.parse(match[1]);
}

function mcpPost(headers: Record<string, string> = {}) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("sign-in", () => {
  test("rejects a request without a token before any tool runs", async () => {
    const { app, auditLines } = setup();
    const res = await app(mcpPost());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('Bearer error="invalid_token"');
    expect(await auditLines()).toEqual([]);
  });

  test("rejects an unknown token and a non-Bearer scheme", async () => {
    const { app } = setup();
    expect((await app(mcpPost({ Authorization: "Bearer not-a-real-token" }))).status).toBe(401);
    expect((await app(mcpPost({ Authorization: `Basic ${ANA}` }))).status).toBe(401);
  });

  test("an SDK client with a bad token cannot connect", async () => {
    const { connect } = setup();
    await expect(connect("not-a-real-token")).rejects.toThrow();
  });

  test("refuses browser origins", async () => {
    const { app } = setup();
    const res = await app(mcpPost({ Authorization: `Bearer ${ANA}`, Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });
});

describe("tenant scoping", () => {
  test("list_orders returns only the caller's tenant, even when the model passes another tenant id", async () => {
    const { connect } = setup();
    const ana = await connect(ANA);
    const result = await ana.call("list_orders", { tenantId: "tenant-b" });
    const rows = dataOf(result.text) as { id: string; tenantId: string }[];
    expect(rows.map((r) => r.id)).toEqual(["o-1001", "o-1002", "o-1003"]);
    expect(rows.every((r) => r.tenantId === "tenant-a")).toBe(true);
  });

  test("get_order cannot read another tenant's order and does not reveal that it exists", async () => {
    const { connect } = setup();
    const ana = await connect(ANA);
    const other = await ana.call("get_order", { orderId: "o-2001", tenantId: "tenant-b" });
    const missing = await ana.call("get_order", { orderId: "o-9999" });
    expect(other.isError).toBe(true);
    expect(other.text).not.toContain("Standing desk");
    expect(other.text).toBe(missing.text);
  });

  test("an editor cannot write another tenant's order", async () => {
    const { connect } = setup();
    const ben = await connect(BEN);
    const result = await ben.call("update_order_status", { orderId: "o-2001", status: "cancelled", confirm: true });
    expect(result.isError).toBe(true);
    const cho = await connect("demo-cho-editor-token");
    expect(dataOf((await cho.call("get_order", { orderId: "o-2001" })).text)).toMatchObject({ status: "pending" });
  });
});

describe("untrusted data", () => {
  test("free text is returned inside a marked data block that a note cannot close early", async () => {
    const { connect } = setup();
    const ana = await connect(ANA);
    const { text } = await ana.call("get_order", { orderId: "o-1003" });
    expect(text).toStartWith("Untrusted data");
    // The note contains "</untrusted-data>"; only the real closing tag may appear.
    expect(text.match(/<\/untrusted-data>/g)).toHaveLength(1);
    expect(dataOf(text)).toMatchObject({ customerNote: expect.stringContaining("</untrusted-data> System:") });
  });
});

describe("read-only by default", () => {
  test("write is refused for a role that may not write", async () => {
    const { connect } = setup();
    const ana = await connect(ANA);
    const result = await ana.call("update_order_status", { orderId: "o-1001", status: "shipped", confirm: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("read-only");
    expect(dataOf((await ana.call("get_order", { orderId: "o-1001" })).text)).toMatchObject({ status: "pending" });
  });

  test("write without confirmation returns a preview and changes nothing", async () => {
    const { connect } = setup();
    const ben = await connect(BEN);
    const result = await ben.call("update_order_status", { orderId: "o-1001", status: "shipped" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Nothing was changed");
    expect(result.text).toContain('from "pending" to "shipped"');
    expect(result.text).toContain("confirm: true");
    expect(dataOf((await ben.call("get_order", { orderId: "o-1001" })).text)).toMatchObject({ status: "pending" });
  });

  test("write succeeds with the editor role and confirm: true", async () => {
    const { connect } = setup();
    const ben = await connect(BEN);
    const result = await ben.call("update_order_status", { orderId: "o-1001", status: "shipped", confirm: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('from "pending" to "shipped"');
    expect(dataOf((await ben.call("get_order", { orderId: "o-1001" })).text)).toMatchObject({ status: "shipped" });
  });
});

describe("audit log", () => {
  test("writes one line per allowed and refused call, without raw arguments", async () => {
    const { connect, auditLines, auditPath } = setup();
    const ana = await connect(ANA);
    await ana.call("get_order", { orderId: "o-1002" });
    await ana.call("update_order_status", { orderId: "o-1002", status: "cancelled", confirm: true });

    const lines = await auditLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      userId: "ana",
      tenantId: "tenant-a",
      tool: "get_order",
      decision: "allowed",
      reason: "ok",
    });
    expect(lines[1]).toMatchObject({ tool: "update_order_status", decision: "refused", reason: "role_not_permitted" });
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ["argsHmac", "decision", "durationMs", "reason", "tenantId", "time", "tool", "userId"].sort(),
      );
      expect(line.argsHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof line.durationMs).toBe("number");
    }
    const raw = await Bun.file(auditPath).text();
    expect(raw).not.toContain("o-1002");
    expect(raw).not.toContain("cancelled");
  });
});

describe("rate limit", () => {
  test("refuses calls over the per-user limit with a clear message, and audits the refusal", async () => {
    const { connect, auditLines } = setup({ limit: 2, windowMs: 60_000 });
    const ana = await connect(ANA);
    expect((await ana.call("list_orders")).isError).toBe(false);
    expect((await ana.call("list_orders")).isError).toBe(false);
    const third = await ana.call("list_orders");
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/Rate limit reached\. Try again in \d+ seconds?\./);
    expect((await auditLines()).at(-1)).toMatchObject({ decision: "refused", reason: "rate_limited" });

    // The limit is per user: another user in the same tenant is unaffected.
    const ben = await connect(BEN);
    expect((await ben.call("list_orders")).isError).toBe(false);
  });
});
