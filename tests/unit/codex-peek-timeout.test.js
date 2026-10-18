// Codex SSE peek must not outlive STREAM_FIRST_CHUNK_TIMEOUT_MS.
//
// Root cause guarded here (H1/H2): `_peekSseTransientError()` awaited
// `reader.read()` with no deadline. FETCH_CONNECT_TIMEOUT_MS is already cleared
// once headers arrive, and the stall watchdog is only armed after the peek
// returns, so a Codex reasoning model silent during prefill hung forever; when
// the socket died the swallowed error left `matched` null, the code built a
// replacementBody over the dead upstream, and the client got a truncated 200
// SSE stream ending in "upstream connection lost".
//
// Negative control: without the fix, case 1 (silent upstream) never settles and
// case 2 (direct peek) RESOLVES with { matched: null, replacementBody: <dead> }
// instead of throwing — both assertions below fail.
//
// STREAM_FIRST_CHUNK_TIMEOUT_MS is read by envMs() at module load, so the env
// var must be set before the module is imported dynamically.
process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS = "60";

import { afterAll, describe, expect, it, vi } from "vitest";

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const proxyFetchModule = await import("../../open-sse/utils/proxyFetch.js");

const credentials = {
  accessToken: "test-token",
  connectionId: "test-codex-peek-timeout",
  providerSpecificData: {},
};

// Upstream accepted the request (headers + 200) and then went silent: the body
// never enqueues a byte and never closes.
function silentBody() {
  return new ReadableStream({ start() { /* deliberately silent */ } });
}

function frameBody(text, { close = true } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      if (close) controller.close();
    },
  });
}

const OUTPUT_FRAME = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"OK"}',
  "",
].join("\n");

function executeArgs() {
  return {
    model: "gpt-5.6-luna",
    body: { model: "gpt-5.6-luna", input: "hi" },
    stream: true,
    credentials,
  };
}

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS;
});

describe("Codex SSE peek first-chunk timeout", () => {
  it("throws a retryable timeout instead of returning a dead replacementBody", async () => {
    // H2 guard: the old code swallowed the read error and returned a
    // replacementBody over the dead upstream, which surfaced downstream as
    // "upstream connection lost" on an HTTP 200.
    const executor = new CodexExecutor();
    const response = {
      ok: true,
      status: 200,
      headers: new Map(),
      body: silentBody(),
    };

    const startedAt = Date.now();
    const peek = executor._peekSseTransientError(response, 60);

    await expect(peek).rejects.toMatchObject({
      name: "CodexPeekTimeoutError",
      codexPeekTimeout: true,
      timeoutMs: 60,
    });
    // Bounded: one deadline, not an unbounded read.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("fails fast on a zero budget without acquiring a reader", async () => {
    // A retry with no remaining budget must not open a reader at all.
    const executor = new CodexExecutor();
    const body = new ReadableStream({
      start() { /* silent */ },
    });
    const response = { ok: true, status: 200, headers: new Map(), body };

    const startedAt = Date.now();
    await expect(executor._peekSseTransientError(response, 0)).rejects.toMatchObject({
      codexPeekTimeout: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(100);

    // No reader was handed out, so the stream was never locked.
    expect(body.locked).toBe(false);
  });

  it("retries a transport read failure while budget remains, without leaking an unhandled rejection", async () => {
    const executor = new CodexExecutor();
    // Default budget is DEFAULT_RETRY_CONFIG[502] = 3 retries / 3000ms. Shrink the
    // retry *count* for speed (real values asserted in codex-500-retry.test.js);
    // the peek budget (60ms, shared) still leaves room for a second attempt
    // because attempt 1 fails immediately instead of burning the window.
    executor.config = { ...executor.config, retry: { 502: { attempts: 1, delayMs: 0 } } };

    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map(),
        // Upstream tears the socket down mid-peek (the H2 case: this used to be
        // swallowed, leaving a replacementBody over a dead upstream).
        body: new ReadableStream({
          start(controller) { controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); },
        }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map(),
        body: frameBody(OUTPUT_FRAME),
      }));

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    let result;
    try {
      result = await executor.execute(executeArgs());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // 1 initial attempt + 1 retry, and the retry's stream is handed back intact.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    await expect(result.response.text()).resolves.toBe(OUTPUT_FRAME);
    expect(unhandled).toEqual([]);
  });

  it("shares ONE peek budget across all retries instead of N × the timeout", async () => {
    // Regression guard for the production-masking bug: per-attempt budgeting made
    // the worst case (retries + 1) × STREAM_FIRST_CHUNK_TIMEOUT_MS ≈ 4 × 200s,
    // which is longer than a typical edge/proxy idle timeout — so the fix would
    // never fire before the proxy killed the socket.
    const executor = new CodexExecutor();
    // Generous retry budget so the *only* thing that can stop the loop is the
    // total peek deadline, not retry exhaustion.
    executor.config = { ...executor.config, retry: { 502: { attempts: 5, delayMs: 0 } } };

    const remaining = [];
    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map(),
        body: silentBody(),
      }));

    // Record the budget each attempt was handed, then run the real peek.
    const realPeek = CodexExecutor.prototype._peekSseTransientError;
    const peekSpy = vi
      .spyOn(executor, "_peekSseTransientError")
      .mockImplementation(async (response, timeoutMs) => {
        remaining.push(timeoutMs);
        return realPeek.call(executor, response, timeoutMs);
      });

    const startedAt = Date.now();
    await expect(executor.execute(executeArgs())).rejects.toMatchObject({
      codexPeekTimeout: true,
    });
    const elapsed = Date.now() - startedAt;

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1); // it did retry
    expect(peekSpy).toHaveBeenCalled();
    // Total wall clock stays inside ~one timeout window (60ms here), not N × 60ms
    // with an unbounded number of retries.
    expect(elapsed).toBeLessThan(60 * 3);
    // The budget handed to later attempts is strictly smaller than the first —
    // i.e. it is a shared deadline, not a fresh window per attempt.
    expect(remaining[0]).toBeLessThanOrEqual(60);
    if (remaining.length > 1) {
      expect(remaining[remaining.length - 1]).toBeLessThan(remaining[0]);
    }
  });

  it("leaves the normal SSE path untouched and clears the peek deadline", async () => {
    const executor = new CodexExecutor();
    const response = {
      ok: true,
      status: 200,
      headers: new Map(),
      body: frameBody(OUTPUT_FRAME),
    };

    vi.useFakeTimers();
    let peek;
    try {
      peek = await executor._peekSseTransientError(response, 200000);
      // Timer hygiene: the deadline must not survive the successful exit (a
      // dangling 200s timer would keep the event loop / request context alive).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(OUTPUT_FRAME);
  });

  it("still detects SSE-level capacity errors without waiting for the deadline", async () => {
    const executor = new CodexExecutor();
    const response = {
      ok: true,
      status: 200,
      headers: new Map(),
      body: frameBody([
        "event: error",
        'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
        "",
      ].join("\n")),
    };

    const peek = await executor._peekSseTransientError(response, 200000);
    expect(peek.accountFallback).toBe(true);
    expect(peek.matched).toBeTruthy();
  });
});
