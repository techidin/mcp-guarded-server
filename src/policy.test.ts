import { afterEach, expect, setSystemTime, test } from "bun:test";
import { canWrite, createRateLimiter } from "./policy";

afterEach(() => {
  setSystemTime(); // back to the real clock
});

test("only editors may write", () => {
  expect(canWrite("editor")).toBe(true);
  expect(canWrite("viewer")).toBe(false);
});

test("the rate limit refuses over the limit, says when to retry, and opens again after the window", () => {
  setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
  const rateLimit = createRateLimiter(2, 60_000);
  expect([rateLimit("ana"), rateLimit("ana")]).toEqual([0, 0]);

  setSystemTime(new Date("2026-11-05T00:00:20.500Z"));
  expect(rateLimit("ana")).toBe(40); // 39.5 s left, rounded up
  expect(rateLimit("ana")).toBe(40); // a refused call does not extend the window
  expect(rateLimit("ben")).toBe(0); // per user

  setSystemTime(new Date("2026-11-05T00:01:00.000Z"));
  expect(rateLimit("ana")).toBe(0);
});
