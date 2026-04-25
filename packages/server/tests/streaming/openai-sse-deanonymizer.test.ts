import { describe, it, expect } from "vitest";
import { createOpenaiSseDeanonymizer } from "../../src/streaming/openai-sse-deanonymizer.js";

type Emitted = { event: string; data: string };

function mk(mappings: Array<[string, string]>): Map<string, string> {
  return new Map(mappings);
}

function collectPipeline(mappings: Map<string, string>) {
  const emitted: Emitted[] = [];
  const pipeline = createOpenaiSseDeanonymizer({
    mappingTable: mappings,
    writeEvent: (event, data) => emitted.push({ event, data }),
  });
  return { pipeline, emitted };
}

function extractChoiceText(emitted: Emitted[], choiceIndex: number): string {
  let text = "";
  for (const e of emitted) {
    if (e.data === "[DONE]") continue;
    let payload: { choices?: Array<{ index?: number; delta?: { content?: string | null } }> };
    try {
      payload = JSON.parse(e.data);
    } catch {
      continue;
    }
    for (const choice of payload.choices ?? []) {
      const idx = typeof choice.index === "number" ? choice.index : 0;
      if (idx !== choiceIndex) continue;
      const c = choice.delta?.content;
      if (typeof c === "string") text += c;
    }
  }
  return text;
}

function ssePayload(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("createOpenaiSseDeanonymizer — streaming rewrite pipeline", () => {
  it("forwards [DONE] sentinel verbatim", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    expect(emitted).toEqual([{ event: "message", data: "[DONE]" }]);
  });

  it("deanonymizes a single delta containing a complete pseudonym", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      ssePayload({
        choices: [{ index: 0, delta: { content: "Hello [PERSON_A]" }, finish_reason: null }],
      }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hello Max");
    // [DONE] still arrived
    expect(emitted.at(-1)).toEqual({ event: "message", data: "[DONE]" });
  });

  it("reassembles a pseudonym split across chunk boundaries", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max Mustermann"]]));
    // Split inside the pseudonym token; the buffering pipeline must hold the
    // tail until the closing bracket arrives.
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "Hi [PERS" }, finish_reason: null }] }),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "ON_A]!" }, finish_reason: null }] }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hi Max Mustermann!");
  });

  it("flushes pending tail on finish_reason", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "Hello [PERS" }, finish_reason: null }] }),
    );
    // Closing chunk completes the pseudonym AND signals the choice closes.
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "ON_A]" }, finish_reason: "stop" }] }),
    );
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hello Max");
  });

  it("flushes pending tail on [DONE] when no finish_reason was emitted", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "Hi [PERS" }, finish_reason: null }] }),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "ON_A]" }, finish_reason: null }] }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hi Max");
  });

  it("handles n>1 — multiple choices stream independently", () => {
    const { pipeline, emitted } = collectPipeline(
      mk([
        ["[PERSON_A]", "Anna"],
        ["[PERSON_B]", "Bert"],
      ]),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "Hi [PERS" }, finish_reason: null }] }),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 1, delta: { content: "Hej [PERS" }, finish_reason: null }] }),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 1, delta: { content: "ON_B]" }, finish_reason: "stop" }] }),
    );
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { content: "ON_A]" }, finish_reason: "stop" }] }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hi Anna");
    expect(extractChoiceText(emitted, 1)).toBe("Hej Bert");
  });

  it("passes role/finish_reason chunks through unchanged", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    // First chunk: only role.
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    );
    // Last chunk: only finish_reason.
    pipeline.write(
      ssePayload({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    // Two upstream chunks + [DONE] = 3 emissions, no rewrites.
    expect(emitted.length).toBe(3);
    expect(JSON.parse(emitted[0]!.data).choices[0].delta.role).toBe("assistant");
    expect(JSON.parse(emitted[1]!.data).choices[0].finish_reason).toBe("stop");
  });

  it("forwards malformed JSON verbatim instead of crashing", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    pipeline.write("data: {not valid json\n\n");
    pipeline.end();
    expect(emitted).toEqual([{ event: "message", data: "{not valid json" }]);
  });

  it("does NOT touch tool_calls / function_call payloads", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    // Tool-call delta with a JSON-encoded argument string that happens to
    // contain a pseudonym — must not be rewritten.
    pipeline.write(
      ssePayload({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "lookup", arguments: '{"name":"[PERSON_A]"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    pipeline.write("data: [DONE]\n\n");
    pipeline.end();
    // The tool-call args remain verbatim — the [PERSON_A] token is still in
    // the emitted tool-call arguments string, untouched.
    const firstEmit = emitted[0]!;
    const payload = JSON.parse(firstEmit.data);
    const args = payload.choices[0].delta.tool_calls[0].function.arguments;
    expect(args).toBe('{"name":"[PERSON_A]"}');
  });

  it("byte-by-byte chunked stream still reassembles correctly", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max Mustermann"]]));
    const fullPayload = ssePayload({
      choices: [{ index: 0, delta: { content: "Hi [PERSON_A]!" }, finish_reason: "stop" }],
    }) + "data: [DONE]\n\n";
    for (const ch of fullPayload) pipeline.write(ch);
    pipeline.end();
    expect(extractChoiceText(emitted, 0)).toBe("Hi Max Mustermann!");
  });

  it("preserves the surrounding chunk shape (id, model, object) when rewriting content", () => {
    const { pipeline, emitted } = collectPipeline(mk([["[PERSON_A]", "Max"]]));
    pipeline.write(
      ssePayload({
        id: "chatcmpl-abc",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "Hi [PERSON_A]" }, finish_reason: null }],
      }),
    );
    pipeline.end();
    const payload = JSON.parse(emitted[0]!.data);
    expect(payload.id).toBe("chatcmpl-abc");
    expect(payload.object).toBe("chat.completion.chunk");
    expect(payload.created).toBe(1700000000);
    expect(payload.model).toBe("gpt-4o");
    expect(payload.choices[0].delta.content).toBe("Hi Max");
  });

  it("forwards chunks with no choices array verbatim", () => {
    const { pipeline, emitted } = collectPipeline(mk([]));
    // Some servers send an initial keep-alive chunk with metadata only.
    pipeline.write(ssePayload({ id: "chatcmpl-abc", object: "chat.completion.chunk" }));
    pipeline.end();
    expect(JSON.parse(emitted[0]!.data).id).toBe("chatcmpl-abc");
  });
});
