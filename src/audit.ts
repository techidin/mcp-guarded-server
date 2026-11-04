import { createHmac } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { Caller } from "./auth";

export type Decision = "allowed" | "refused";

export type AuditEvent = {
  caller: Caller;
  tool: string;
  args: unknown;
  decision: Decision;
  reason: string;
  durationMs: number;
};

export type AuditLog = (event: AuditEvent) => Promise<void>;

// Appends one JSON line per tool call. Arguments are never written raw; only
// a keyed hash (HMAC-SHA256) is kept. Someone holding the key can check whether
// a suspected input was used, but the log alone does not reveal it. A plain
// hash would not be enough: short values such as order ids are easy to guess.
export function createAuditLog(path: string, key: string): AuditLog {
  return async ({ caller, tool, args, decision, reason, durationMs }) => {
    const line = {
      time: new Date().toISOString(),
      userId: caller.userId,
      tenantId: caller.tenantId,
      tool,
      decision,
      reason,
      durationMs: Math.round(durationMs * 100) / 100,
      argsHmac: createHmac("sha256", key)
        .update(JSON.stringify(args ?? {}))
        .digest("hex"),
    };
    await appendFile(path, `${JSON.stringify(line)}\n`);
  };
}
