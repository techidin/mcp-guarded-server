import { randomBytes } from "node:crypto";
import orders from "../demo/orders.json";
import users from "../demo/users.json";
import { createApp } from "./server";

const host = process.env.HOST ?? "127.0.0.1"; // local only unless you choose otherwise
const port = Number(process.env.PORT ?? 3000);

let auditKey = process.env.AUDIT_HMAC_KEY;
if (!auditKey) {
  auditKey = randomBytes(32).toString("hex");
  console.warn("AUDIT_HMAC_KEY not set: using a random key, so argument hashes only match within this run.");
}

const app = createApp({
  users,
  orders,
  auditPath: process.env.AUDIT_LOG ?? "audit.log",
  auditKey,
  rateLimit: { limit: 30, windowMs: 60_000 },
});

Bun.serve({ hostname: host, port, fetch: app });
console.log(`MCP endpoint: http://${host}:${port}/mcp`);
