// A 500 from upstream must not lock an account for the 30s transient default.
//
// Root cause guarded here (H3 cascade): accountFallback.js exempts only 400-499,
// so an unmatched 500 fell through to `TRANSIENT_COOLDOWN_MS` (30s). With a sole
// cx account that turned one transient upstream 500 into 30s of
// "all accounts unavailable" (503) for every later request.
import { describe, expect, it } from "vitest";

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

describe("account fallback cooldown for upstream 500", () => {
  it("cools the account for 5s, not the 30s transient default", () => {
    const result = checkFallbackError(500, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(5000);
    expect(result.cooldownMs).not.toBe(TRANSIENT_COOLDOWN_MS);
    // A flat cooldown, not exponential backoff.
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("leaves the 503 transient default untouched (change is scoped to 500/502)", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    expect(result.cooldownMs).toBe(30000);
  });

  it("cools the account for 5s on a 502 (codex peek timeout surfaces as 502)", () => {
    // A persistent peek timeout is rethrown from codex.execute and chatCore maps
    // it to 502. Without a rule it would fall through to the 30s transient
    // default and 503 every later request on a sole account.
    const result = checkFallbackError(502, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(5000);
    expect(result.cooldownMs).not.toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("keeps 504 on the transient default", () => {
    expect(checkFallbackError(504, "upstream exploded").cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("still lets text rules win over the 500 status rule", () => {
    // "rate limit" matches a backoff text rule before the status loop is reached.
    const result = checkFallbackError(500, "rate limit reached", 0);

    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
    expect(result.cooldownMs).not.toBe(5000);
  });

  it("keeps the client-error exemption for 4xx intact", () => {
    expect(checkFallbackError(400, "bad request")).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });
});
