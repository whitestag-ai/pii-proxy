import { describe, it, expect, vi } from "vitest";
import { createSseParser, type SseEvent } from "../src/streaming/sse-parser.js";

function collect(parser: ReturnType<typeof createSseParser>, onEvent: (e: SseEvent) => void) {
  parser.setListener(onEvent);
}

describe("createSseParser", () => {
  it("parses a single complete event with event + data fields", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event: ping\ndata: {\"ok\":true}\n\n");
    expect(events).toEqual([{ event: "ping", data: '{"ok":true}' }]);
  });

  it("treats events without 'event:' field as default 'message'", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("data: hello\n\n");
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("joins multiple 'data:' lines with a single \\n", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event: multiline\ndata: line 1\ndata: line 2\ndata: line 3\n\n");
    expect(events).toEqual([{ event: "multiline", data: "line 1\nline 2\nline 3" }]);
  });

  it("ignores comment lines starting with ':'", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write(":keepalive heartbeat\nevent: ping\ndata: 1\n\n");
    expect(events).toEqual([{ event: "ping", data: "1" }]);
  });

  it("handles an event split across multiple write() calls", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event: content_bl");
    expect(events).toEqual([]);
    p.write("ock_delta\ndata: {\"type\":\"text");
    expect(events).toEqual([]);
    p.write("_delta\",\"text\":\"Hi\"}\n\n");
    expect(events).toEqual([
      { event: "content_block_delta", data: '{"type":"text_delta","text":"Hi"}' },
    ]);
  });

  it("handles multiple events in a single write() call", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write(
      "event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n",
    );
    expect(events).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
      { event: "c", data: "3" },
    ]);
  });

  it("handles CRLF line endings", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event: ping\r\ndata: ok\r\n\r\n");
    expect(events).toEqual([{ event: "ping", data: "ok" }]);
  });

  it("tolerates 'data:' without leading space", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event:ping\ndata:payload\n\n");
    expect(events).toEqual([{ event: "ping", data: "payload" }]);
  });

  it("ignores unknown fields (id:, retry:, future fields)", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("id: 42\nretry: 1000\nevent: ping\ndata: 1\nfuture: bar\n\n");
    expect(events).toEqual([{ event: "ping", data: "1" }]);
  });

  it("does NOT emit an event that has no blank line terminator yet", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("event: ping\ndata: ok\n");
    expect(events).toEqual([]);
    p.write("\n");
    expect(events).toEqual([{ event: "ping", data: "ok" }]);
  });

  it("character-by-character input reconstructs correctly", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    const input = "event: ping\ndata: hi\n\n";
    for (const ch of input) p.write(ch);
    expect(events).toEqual([{ event: "ping", data: "hi" }]);
  });

  it("swallows an empty event (blank line with no fields)", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write("\n\n");
    expect(events).toEqual([]);
  });

  it("emits events in the order they appear", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    p.write(
      "event: first\ndata: a\n\nevent: second\ndata: b\n\nevent: third\ndata: c\n\n",
    );
    expect(events.map((e) => e.event)).toEqual(["first", "second", "third"]);
  });

  it("preserves JSON payload exactly (no mangling of braces, colons, spaces)", () => {
    const events: SseEvent[] = [];
    const p = createSseParser();
    collect(p, (e) => events.push(e));
    const payload = '{"type":"text_delta","delta":{"text":"Hi [PERSON_A], how are you?"}}';
    p.write(`event: content_block_delta\ndata: ${payload}\n\n`);
    expect(events[0].data).toBe(payload);
  });

  it("allows listener to be swapped between writes (last listener wins)", () => {
    const p = createSseParser();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    p.setListener(firstListener);
    p.write("event: a\ndata: 1\n\n");
    expect(firstListener).toHaveBeenCalledTimes(1);
    p.setListener(secondListener);
    p.write("event: b\ndata: 2\n\n");
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
  });
});
