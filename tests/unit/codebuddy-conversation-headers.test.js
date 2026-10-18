import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPECTED_STATIC_HEADERS = {
  "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
  "X-Product": "SaaS",
  "X-IDE-Type": "IDE",
  "X-IDE-Name": "IDE",
  "x-requested-with": "XMLHttpRequest",
  "x-codebuddy-request": "1",
};

describe("CodeBuddyIntlExecutor conversation headers", () => {
  const dummyCreds = { apiKey: "test-token-sk-12345" };

  it("sets exact header names with valid UUID v4 format", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(dummyCreds, true);

    expect(headers).toHaveProperty("X-Conversation-ID");
    expect(headers).toHaveProperty("X-Conversation-Request-ID");
    expect(headers).toHaveProperty("X-Conversation-Message-ID");

    expect(headers["X-Conversation-ID"]).toMatch(UUID_V4_REGEX);
    expect(headers["X-Conversation-Request-ID"]).toMatch(UUID_V4_REGEX);
    expect(headers["X-Conversation-Message-ID"]).toMatch(UUID_V4_REGEX);
  });

  it("ensures intra-request distinctness among all three UUIDs", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(dummyCreds, true);

    const convId = headers["X-Conversation-ID"];
    const reqId = headers["X-Conversation-Request-ID"];
    const msgId = headers["X-Conversation-Message-ID"];

    expect(convId).not.toBe(reqId);
    expect(convId).not.toBe(msgId);
    expect(reqId).not.toBe(msgId);

    const uniqueSet = new Set([convId, reqId, msgId]);
    expect(uniqueSet.size).toBe(3);
  });

  it("ensures inter-request freshness across successive calls", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers1 = executor.buildHeaders(dummyCreds, true);
    const headers2 = executor.buildHeaders(dummyCreds, true);

    expect(headers1["X-Conversation-ID"]).not.toBe(headers2["X-Conversation-ID"]);
    expect(headers1["X-Conversation-Request-ID"]).not.toBe(headers2["X-Conversation-Request-ID"]);
    expect(headers1["X-Conversation-Message-ID"]).not.toBe(headers2["X-Conversation-Message-ID"]);
  });

  it("preserves Authorization, Content-Type, streaming Accept, and static CodeBuddy headers", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(dummyCreds, true);

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer test-token-sk-12345");
    expect(headers["Accept"]).toBe("text/event-stream");

    for (const [key, value] of Object.entries(EXPECTED_STATIC_HEADERS)) {
      expect(headers[key]).toBe(value);
    }

    const nonStreamHeaders = executor.buildHeaders(dummyCreds, false);
    expect(nonStreamHeaders["Accept"]).toBeUndefined();
  });

  it("does not emit unexpected or unrelated headers", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(dummyCreds, true);

    const expectedKeys = new Set([
      "Content-Type",
      "Authorization",
      "Accept",
      "User-Agent",
      "X-Product",
      "X-IDE-Type",
      "X-IDE-Name",
      "x-requested-with",
      "x-codebuddy-request",
      "X-Conversation-ID",
      "X-Conversation-Request-ID",
      "X-Conversation-Message-ID",
    ]);

    const actualKeys = Object.keys(headers);
    for (const key of actualKeys) {
      expect(expectedKeys.has(key)).toBe(true);
    }
    expect(actualKeys.length).toBe(expectedKeys.size);
  });

  it("protects generated identity from providerOverrides.headers collision and client injection", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(
      {
        apiKey: "test-token-sk-12345",
        rawHeaders: {
          "x-conversation-id": "client-supplied-raw-id",
          "X-Conversation-ID": "client-supplied-raw-id",
        },
      },
      true
    );

    const originalConvId = headers["X-Conversation-ID"];
    const originalReqId = headers["X-Conversation-Request-ID"];
    const originalMsgId = headers["X-Conversation-Message-ID"];

    // Raw credentials headers must not replace generated UUIDs
    expect(originalConvId).not.toBe("client-supplied-raw-id");
    expect(originalConvId).toMatch(UUID_V4_REGEX);

    // Simulate BaseExecutor override merge: Object.assign(headers, providerOverrides.headers)
    Object.assign(headers, {
      "X-Conversation-ID": "overridden-id",
      "x-conversation-id": "overridden-lower-id",
      "X-Conversation-Request-ID": "overridden-req-id",
      "X-Conversation-Message-ID": "overridden-msg-id",
      "X-Allowed-Override": "allowed-value",
    });

    // Guarded headers must keep their original UUID values
    expect(headers["X-Conversation-ID"]).toBe(originalConvId);
    expect(headers["X-Conversation-Request-ID"]).toBe(originalReqId);
    expect(headers["X-Conversation-Message-ID"]).toBe(originalMsgId);
    expect(headers["x-conversation-id"]).toBeUndefined();

    // Legitimate custom override must be preserved
    expect(headers["X-Allowed-Override"]).toBe("allowed-value");
  });
});
