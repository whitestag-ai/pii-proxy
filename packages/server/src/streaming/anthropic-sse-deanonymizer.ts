/**
 * Pure, testable core of the Anthropic SSE streaming-deanonymization path.
 *
 * Feed raw SSE bytes (as strings) via `write()`, the processor parses each
 * complete event, routes `content_block_delta` text-deltas and tool-call
 * `input_json_delta`s through a per-index streaming deanonymizer, and emits
 * patched SSE events via the `writeEvent` callback. All other event types
 * pass through verbatim.
 *
 * `partial_json` is a fragment of a JSON document, so plaintext is escaped for
 * a JSON string before it is substituted there.
 *
 * On `end()`, any still-buffered text per block is flushed as a synthetic
 * final `content_block_delta` event before the caller closes the stream.
 *
 * Separated from the Fastify route so it can be unit- and fuzz-tested
 * without a real HTTP server.
 */

import { createStreamDeanonymizer } from "@whitestag/pii-proxy-core";
import { createSseParser } from "./sse-parser.js";

export interface AnthropicSseDeanonymizerOptions {
  mappingTable: Map<string, string>;
  writeEvent: (event: string, data: string) => void;
}

export interface AnthropicSseDeanonymizer {
  write(chunk: string): void;
  end(): void;
}

export function createAnthropicSseDeanonymizer(
  opts: AnthropicSseDeanonymizerOptions,
): AnthropicSseDeanonymizer {
  type BlockStream = {
    stream: ReturnType<typeof createStreamDeanonymizer>;
    deltaType: "text_delta" | "input_json_delta";
  };
  const perBlockStreams = new Map<number, BlockStream>();
  const parser = createSseParser();
  const jsonEscapedMappings = new Map(
    [...opts.mappingTable].map(([pseudonym, plain]) => [
      pseudonym,
      JSON.stringify(plain).slice(1, -1),
    ]),
  );

  const writeTail = (index: number, block: BlockStream, tail: string): void => {
    if (tail.length === 0) return;
    const delta =
      block.deltaType === "input_json_delta"
        ? { type: "input_json_delta", partial_json: tail }
        : { type: "text_delta", text: tail };
    opts.writeEvent(
      "content_block_delta",
      JSON.stringify({ type: "content_block_delta", index, delta }),
    );
  };

  parser.setListener((evt) => {
    if (evt.event === "content_block_stop") {
      let idx: number | null = null;
      try {
        const payload = JSON.parse(evt.data) as Record<string, unknown>;
        if (typeof payload.index === "number") idx = payload.index;
      } catch {
        /* malformed; pass through below */
      }
      if (idx !== null) {
        const block = perBlockStreams.get(idx);
        if (block) {
          const tail = block.stream.end();
          perBlockStreams.delete(idx);
          writeTail(idx, block, tail);
        }
      }
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    if (evt.event !== "content_block_delta") {
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    const index = typeof payload.index === "number" ? payload.index : 0;
    const delta = payload.delta as Record<string, unknown> | undefined;
    const isText =
      !!delta &&
      typeof delta === "object" &&
      (delta.type === "text_delta" || delta.type === "text") &&
      typeof delta.text === "string";
    const isToolJson =
      !!delta &&
      typeof delta === "object" &&
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string";
    if (!isText && !isToolJson) {
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    let block = perBlockStreams.get(index);
    if (!block) {
      block = isToolJson
        ? { stream: createStreamDeanonymizer(jsonEscapedMappings), deltaType: "input_json_delta" }
        : { stream: createStreamDeanonymizer(opts.mappingTable), deltaType: "text_delta" };
      perBlockStreams.set(index, block);
    }
    const field = isToolJson ? "partial_json" : "text";
    const emitted = block.stream.write(delta![field] as string);
    if (emitted.length === 0) return;
    const patched = { ...payload, delta: { ...delta, [field]: emitted } };
    opts.writeEvent(evt.event, JSON.stringify(patched));
  });

  return {
    write(chunk: string): void {
      parser.write(chunk);
    },
    end(): void {
      for (const [idx, block] of perBlockStreams.entries()) {
        writeTail(idx, block, block.stream.end());
      }
      perBlockStreams.clear();
    },
  };
}
