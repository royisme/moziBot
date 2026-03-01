import { describe, it, expect } from "vitest";
import { selectMessages } from "./tape-context.js";
import type { TapeEntry } from "./types.js";

describe("selectMessages", () => {
  it("should return empty array for empty entries", () => {
    const messages = selectMessages([]);
    expect(messages).toHaveLength(0);
  });

  it("should convert message entries to role/content messages", () => {
    const entries: TapeEntry[] = [
      { id: 1, kind: "message", payload: { role: "user", content: "Hello" }, meta: {} },
      { id: 2, kind: "message", payload: { role: "assistant", content: "Hi there" }, meta: {} },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("should convert system entries to system messages", () => {
    const entries: TapeEntry[] = [
      { id: 1, kind: "system", payload: { content: "You are a helpful assistant" }, meta: {} },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "system", content: "You are a helpful assistant" });
  });

  it("should skip anchor entries", () => {
    const entries: TapeEntry[] = [
      { id: 1, kind: "message", payload: { role: "user", content: "Hello" }, meta: {} },
      { id: 2, kind: "anchor", payload: { name: "phase-1", state: {} }, meta: {} },
      { id: 3, kind: "message", payload: { role: "assistant", content: "Hi" }, meta: {} },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].content).toBe("Hi");
  });

  it("should skip event entries", () => {
    const entries: TapeEntry[] = [
      { id: 1, kind: "message", payload: { role: "user", content: "Hello" }, meta: {} },
      { id: 2, kind: "event", payload: { name: "step.start", data: {} }, meta: {} },
      { id: 3, kind: "message", payload: { role: "assistant", content: "Hi" }, meta: {} },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(2);
  });

  it("should convert tool_call to assistant message with tool_calls", () => {
    const entries: TapeEntry[] = [
      {
        id: 1,
        kind: "tool_call",
        payload: {
          calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city": "NYC"}' },
            },
          ],
        },
        meta: {},
      },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("");
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls![0].id).toBe("call_1");
  });

  it("should pair tool_result with preceding tool_call", () => {
    const entries: TapeEntry[] = [
      {
        id: 1,
        kind: "tool_call",
        payload: {
          calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
          ],
        },
        meta: {},
      },
      {
        id: 2,
        kind: "tool_result",
        payload: {
          results: ["Weather result", "Time result"],
        },
        meta: {},
      },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(3); // 1 tool_call + 2 tool_results

    // First is tool_call
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].tool_calls).toBeDefined();

    // Second is tool result for first call
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content).toBe("Weather result");
    expect(messages[1].tool_call_id).toBe("call_1");
    expect(messages[1].name).toBe("get_weather");

    // Third is tool result for second call
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toBe("Time result");
    expect(messages[2].tool_call_id).toBe("call_2");
    expect(messages[2].name).toBe("get_time");
  });

  it("should handle tool_result without preceding tool_call", () => {
    const entries: TapeEntry[] = [
      {
        id: 1,
        kind: "tool_result",
        payload: {
          results: ["Standalone result"],
        },
        meta: {},
      },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].content).toBe("Standalone result");
    expect(messages[0].tool_call_id).toBeUndefined();
  });

  it("should JSON stringify non-string results", () => {
    const entries: TapeEntry[] = [
      {
        id: 1,
        kind: "tool_result",
        payload: {
          results: [{ status: "success", data: { temp: 72 } }],
        },
        meta: {},
      },
    ];

    const messages = selectMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('{"status":"success","data":{"temp":72}}');
  });

  it("should handle mixed entry types in order", () => {
    const entries: TapeEntry[] = [
      { id: 1, kind: "system", payload: { content: "System prompt" }, meta: {} },
      { id: 2, kind: "message", payload: { role: "user", content: "Hello" }, meta: {} },
      { id: 3, kind: "message", payload: { role: "assistant", content: "Hi" }, meta: {} },
      {
        id: 4,
        kind: "tool_call",
        payload: { calls: [{ id: "c1", function: { name: "test" } }] },
        meta: {},
      },
      { id: 5, kind: "tool_result", payload: { results: ["result"] }, meta: {} },
      { id: 6, kind: "anchor", payload: { name: "phase-1" }, meta: {} },
      { id: 7, kind: "message", payload: { role: "user", content: "After anchor" }, meta: {} },
    ];

    const messages = selectMessages(entries);

    // Should include: system, user, assistant, tool_call, tool_result, user (after anchor)
    // Skip: anchor, event
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].tool_calls).toBeDefined();
    expect(messages[4].role).toBe("tool");
    expect(messages[5].content).toBe("After anchor");
  });
});
