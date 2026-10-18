import { describe, it, expect, vi } from "vitest";

// Same-format streaming goes through createPassthroughStreamWithLogger(), which
// historically never received toolNameMap — so names aliased for the upstream
// (opencode fingerprint `shell_client`/`read_client`, Claude cloaking) leaked to
// the client and were rejected as unknown tools. These tests pin the restore.

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const chatChunk = (name, id, index = 0) => JSON.stringify({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [{
    index: 0,
    delta: {
      role: "assistant",
      content: "",
      tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
    },
  }],
  usage: null,
});

async function run({ sse, toolNameMap, sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI }) {
  const providerResponse = new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const { response } = await handleStreamingResponse({
    providerResponse,
    provider: "openai",
    model: "test-model",
    sourceFormat,
    targetFormat,
    userAgent: "opencode/2.0.32",
    body: { model: "test-model", stream: true, messages: [{ role: "user", content: "hi" }] },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "test-conn",
    apiKey: "test-key",
    clientRawRequest: null,
    onRequestSuccess: null,
    reqLogger: null,
    toolNameMap,
    customToolNames: null,
    streamController: {
      handleError: vi.fn(),
      abort: vi.fn(),
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      isConnected: () => true,
      signal: undefined,
      startTime: Date.now(),
    },
    onStreamComplete: null,
    streamDetailId: "test-detail",
    pxpipe: null,
    reqTag: "test-tag",
    log: null,
    credentials: null,
  });
  return response.text();
}

const FINGERPRINT_MAP = new Map([["shell_client", "shell"], ["read_client", "read"]]);

describe("same-format streaming passthrough restores upstream-aliased tool names", () => {
  it("restores fingerprint aliases in chat deltas", async () => {
    const sse =
      `data: ${chatChunk("shell_client", "call_1", 0)}\n\n` +
      `data: ${chatChunk("read_client", "call_2", 1)}\n\n` +
      "data: [DONE]\n\n";

    const text = await run({ sse, toolNameMap: FINGERPRINT_MAP });

    expect(text).toContain('"name":"shell"');
    expect(text).toContain('"name":"read"');
    expect(text).not.toContain("shell_client");
    expect(text).not.toContain("read_client");
    expect(text).toContain("data: [DONE]");
  });

  it("restores aliases on a trailing chunk that lands in flush()", async () => {
    // No trailing newline: the last data line stays in the buffer until flush.
    const sse =
      `data: ${chatChunk("shell_client", "call_1", 0)}\n\n` +
      `data: ${chatChunk("read_client", "call_2", 1)}`;

    const text = await run({ sse, toolNameMap: FINGERPRINT_MAP });

    expect(text).toContain('"name":"read"');
    expect(text).not.toContain("shell_client");
    expect(text).not.toContain("read_client");
  });

  it("restores cloaked names in Claude content_block_start passthrough", async () => {
    const sse =
      "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash_ide","input":{}}}\n\n';

    const text = await run({
      sse,
      toolNameMap: new Map([["Bash_ide", "Bash"]]),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
    });

    expect(text).toContain('"name":"Bash"');
    expect(text).not.toContain("Bash_ide");
  });

  it("leaves tool names untouched when no rename map is present", async () => {
    const sse = `data: ${chatChunk("shell_client", "call_1", 0)}\n\n` + "data: [DONE]\n\n";

    const text = await run({ sse, toolNameMap: null });

    expect(text).toContain("shell_client");
  });
});
