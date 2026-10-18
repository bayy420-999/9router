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
    const peek = executor._peekSseTransientError(response);

    await expect(peek).rejects.toMatchObject({
      name: "CodexPeekTimeoutError",
      codexPeekTimeout: true,
      timeoutMs: 60,
    });
    // Bounded: one deadline, not an unbounded read.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("retries the transport failure then rejects, without leaking an unhandled rejection", async () => {
    const executor = new CodexExecutor();
    // Default budget is DEFAULT_RETRY_CONFIG[502] = 3 retries / 3000ms. Shrink it
    // for the test (the real values are asserted in codex-500-retry.test.js);
    // the retry *path* is what matters here.
    executor.config = { ...executor.config, retry: { 502: { attempts: 1, delayMs: 0 } } };

    const fetchSpy = vi
      .spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map(),
        body: silentBody(),
      }));

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(executor.execute(executeArgs())).rejects.toMatchObject({
        codexPeekTimeout: true,
      });
      // The raced reader.read() settles after the deadline wins; it must be
      // marked handled (readPromise.catch(() => {})) or it surfaces here.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // 1 initial attempt + 1 retry from the shrunken 502 budget.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
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
      peek = await executor._peekSseTransientError(response);
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

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.matched).toBeTruthy();
  });
});
