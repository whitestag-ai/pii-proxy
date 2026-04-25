import { describe, it, expect } from "vitest";
import { createAnthropicSseDeanonymizer } from "../../src/streaming/anthropic-sse-deanonymizer.js";

type Emitted = { event: string; data: string };

function mk(mappings: Array<[string, string]>): Map<string, string> {
  return new Map(mappings);
}

function collectPipeline(mappings: Map<string, string>) {
  const emitted: Emitted[] = [];
  const pipeline = createAnthropicSseDeanonymizer({
    mappingTable: mappings,
    writeEvent: (event, data) => emitted.push({ event, data }),
  });
  return { pipeline, emitted };
}

function extractFullBlockText(emitted: Emitted[], blockIndex: number): string {
  let text = "";
  for (const e of emitted) {
    if (e.event !== "content_block_delta") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(e.data);
    } catch {
      continue;
    }
    if (payload.index !== blockIndex) continue;
    const delta = payload.delta as { type?: string; text?: string } | undefined;
    if (delta && (delta.type === "text_delta" || delta.type === "text") && typeof delta.text === "string") {
      text += delta.text;
    }
  }
  return text;
}

describe("createAnthropicSseDeanonymizer — streaming rewrite pipeline", () => {
  it("passes non-delta events through verbatim", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    pipeline.write(
      "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" +
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    pipeline.end();
    expect(emitted.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "message_stop",
    ]);
  });

  it("deanonymizes a single text_delta containing a complete pseudonym", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi [PERSON_A]" },
        }) +
        "\n\n",
    );
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("Hi Max");
  });

  it("reassembles a pseudonym split across 3 text_deltas", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max Mustermann"]]));
    const deltas = ["Hi [", "PERSON_", "A], welcome."];
    for (const t of deltas) {
      pipeline.write(
        "event: content_block_delta\ndata: " +
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: t },
          }) +
          "\n\n",
      );
    }
    pipeline.write(
      "event: content_block_stop\ndata: " +
        JSON.stringify({ type: "content_block_stop", index: 0 }) +
        "\n\n",
    );
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("Hi Max Mustermann, welcome.");
  });

  it("handles multi-block output (index 0 and index 1 independently)", () => {
    const { pipeline, emitted } = collectPipeline(
      mk([
        ["[PERSON_A]", "Alice"],
        ["[PERSON_B]", "Bob"],
      ]),
    );
    // Block 0
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({
          index: 0,
          delta: { type: "text_delta", text: "From [PERSON_A]" },
        }) +
        "\n\n",
    );
    // Block 1
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({
          index: 1,
          delta: { type: "text_delta", text: "To [PERSON_B]" },
        }) +
        "\n\n",
    );
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("From Alice");
    expect(extractFullBlockText(emitted, 1)).toBe("To Bob");
  });

  it("flushes held-back buffer on content_block_stop", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    // Write a delta that holds back "[PERS" (no close yet)
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({ index: 0, delta: { type: "text_delta", text: "safe [PERS" } }) +
        "\n\n",
    );
    // The safe-prefix algorithm will emit "safe " and hold "[PERS".
    // Now content_block_stop arrives without completing the pseudonym —
    // the buffer is flushed as literal.
    pipeline.write(
      "event: content_block_stop\ndata: " +
        JSON.stringify({ index: 0 }) +
        "\n\n",
    );
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("safe [PERS");
    // And a content_block_stop event was forwarded.
    expect(emitted.some((e) => e.event === "content_block_stop")).toBe(true);
  });

  it("flushes still-open blocks on pipeline.end() when upstream ended without stop event", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({ index: 0, delta: { type: "text_delta", text: "[PERSON_A]" } }) +
        "\n\n",
    );
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("Max");
  });

  it("forwards non-text deltas (tool_use input_json_delta) unchanged", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      "event: content_block_delta\ndata: " +
        JSON.stringify({
          index: 2,
          delta: { type: "input_json_delta", partial_json: "{\"foo\":\"[PERSON_A]\"}" },
        }) +
        "\n\n",
    );
    pipeline.end();
    // Passed through unchanged (tool-use anonymization is Phase 2).
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("content_block_delta");
    const payload = JSON.parse(emitted[0].data);
    expect(payload.delta.type).toBe("input_json_delta");
    expect(payload.delta.partial_json).toBe('{"foo":"[PERSON_A]"}');
  });

  it("accepts input split across arbitrarily many write() calls", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    const fullSse =
      "event: content_block_delta\ndata: " +
      JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hello [PERSON_A]!" } }) +
      "\n\n" +
      "event: content_block_stop\ndata: {\"index\":0}\n\n";
    // Write one byte at a time.
    for (const ch of fullSse) pipeline.write(ch);
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("Hello Max!");
  });

  it("forwards malformed content_block_delta (non-JSON data) verbatim", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    pipeline.write("event: content_block_delta\ndata: not-json\n\n");
    pipeline.end();
    expect(emitted).toEqual([{ event: "content_block_delta", data: "not-json" }]);
  });

  it("never emits a partial pseudonym mid-stream", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    const chunks = ["hi ", "[", "PERSON_A]"];
    let seen = "";
    for (const text of chunks) {
      pipeline.write(
        "event: content_block_delta\ndata: " +
          JSON.stringify({ index: 0, delta: { type: "text_delta", text } }) +
          "\n\n",
      );
      seen = extractFullBlockText(emitted, 0);
      expect(seen).not.toMatch(/\[PER/); // never leaked a partial pseudonym
    }
    pipeline.end();
    expect(extractFullBlockText(emitted, 0)).toBe("hi Max");
  });

  it("end-to-end: Anthropic-style 10-token stream for 'Hi [PERSON_A], Max-Details: [EMAIL_A]'", () => {
    const map = mk([
      ["[PERSON_A]", "Max Mustermann"],
      ["[EMAIL_A]", "max@example.de"],
    ]);
    const { pipeline, emitted } = collectPipeline(map);
    // 1. message_start
    pipeline.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    // 2. content_block_start
    pipeline.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    // 3–12. content_block_delta (token-ish splits, with pseudonyms across chunks)
    const tokens = [
      "Hi ",
      "[",
      "PERSON",
      "_A",
      "], Max-Details: [",
      "EMAIL_",
      "A",
      "]",
    ];
    for (const t of tokens) {
      pipeline.write(
        "event: content_block_delta\ndata: " +
          JSON.stringify({ index: 0, delta: { type: "text_delta", text: t } }) +
          "\n\n",
      );
    }
    // 13. content_block_stop
    pipeline.write('event: content_block_stop\ndata: {"index":0}\n\n');
    // 14. message_delta
    pipeline.write('event: message_delta\ndata: {"type":"message_delta"}\n\n');
    // 15. message_stop
    pipeline.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    pipeline.end();

    const full = extractFullBlockText(emitted, 0);
    expect(full).toBe("Hi Max Mustermann, Max-Details: max@example.de");
    // Full frame ordering preserved for non-delta events:
    expect(emitted.filter((e) => e.event !== "content_block_delta").map((e) => e.event))
      .toEqual(["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
  });
});
