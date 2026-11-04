import type { Role } from "./auth";

// Read-only is the default. Only the roles named here may run write tools.
export const canWrite = (role: Role): boolean => role === "editor";

// Returns 0 when the call may run, otherwise the seconds until the next window.
export type RateLimiter = (userId: string) => number;

// Fixed window per user: at most `limit` tool calls per `windowMs`.
// Keys are verified user ids (it runs after sign-in), so the map is bounded by
// the number of users.
// ponytail: in-memory and per process; a fixed window allows a 2x burst at the
// window edge. Use a shared store and a sliding window when running more than
// one instance.
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();

  return (userId) => {
    const now = Date.now();
    const window = windows.get(userId);
    if (!window || now - window.start >= windowMs) {
      windows.set(userId, { start: now, count: 1 });
      return 0;
    }
    if (window.count >= limit) return Math.ceil((window.start + windowMs - now) / 1000);
    window.count++;
    return 0;
  };
}
