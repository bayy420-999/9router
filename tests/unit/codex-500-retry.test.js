// Codex upstream HTTP 500 must be retried before it reaches the client.
//
// Root cause guarded here (H3): DEFAULT_RETRY_CONFIG covers 429/502/503/504 but
// not 500, and the codex registry declared no `retry` override, so
// base.js tryRetry(500) resolved to { attempts: 0 } and a single transient
// upstream 500 was returned to the client as a JSON 500 — before any SSE
// header — which then locked the sole cx account for the 30s transient cooldown.
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DEFAULT_RETRY_CONFIG } from "../../open-sse/config/runtimeConfig.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = {
  accessToken: "test-token",
  connectionId: "test-codex-500-retry",
  providerSpecificData: {},
};

function executeArgs() {
  return {
    model: "gpt-5.6-luna",
    body: { model: "gpt-5.6-luna", input: "hi" },
    stream: true,
    credentials,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex 500 retry config", () => {
  it("exposes the registry override through PROVIDERS.codex.retry", () => {
    // Proves the registry entry actually reaches the executor: base.js does
    // `{ ...DEFAULT_RETRY_CONFIG, ...this.config.retry }` and this.config is
    // PROVIDERS.codex (providers/index.js spreads entry.transport into it).
    expect(PROVIDERS.codex.retry).toMatchObject({
      500: { attempts: 2, delayMs: 2000 },
    });
  });

  it("adds 500 without dropping the shared 502/503/504 defaults", () => {
    // The override must add 500, not replace the rest: base.js merges
    // { ...DEFAULT_RETRY_CONFIG, ...this.config.retry }.
    const executor = new CodexExecutor();
    const merged = { ...DEFAULT_RETRY_CONFIG, ...executor.config.retry };
    expect(merged[500]).toEqual({ attempts: 2, delayMs: 2000 });
    expect(merged[502]).toEqual({ attempts: 3, delayMs: 3000 });
    expect(merged[503]).toEqual({ attempts: 3, delayMs: 2000 });
    expect(merged[504]).toEqual({ attempts: 2, delayMs: 3000 });
    expect(merged[429]).toEqual({ attempts: 0, delayMs: 0 });
  });
});

describe("Codex 500 retry behavior", () => {
  it("retries a 500 twice before surfacing it", async () => {
    const executor = new CodexExecutor();
    // Same attempts as the registry, zero delay so the test stays fast.
    executor.config = { ...executor.config, retry: { 500: { attempts: 2, delayMs: 0 } } };

    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Map(),
        text: async () => "upstream exploded",
      }));

    const result = await executor.execute(executeArgs());

    // 1 initial attempt + 2 retries.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Exhausted retries still surface the real upstream status (a clean 500),
    // not a fabricated 200 stream.
    expect(result.response.status).toBe(500);
  });

  it("does not retry a 500 without the override (pre-fix control)", async () => {
    const executor = new CodexExecutor();
    // Simulate the pre-fix registry: no 500 entry, so tryRetry(500) → attempts 0.
    executor.config = { ...executor.config, retry: {} };

    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Map(),
        text: async () => "upstream exploded",
      }));

    const result = await executor.execute(executeArgs());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(500);
  });
});
