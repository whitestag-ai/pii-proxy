/**
 * Pure, testable core of the Anthropic SSE streaming-deanonymization path.
 *
 * Feed raw SSE bytes (as strings) via `write()`, the processor parses each
 * complete event, routes `content_block_delta` text-deltas through a
 * per-index streaming deanonymizer, and emits patched SSE events via the
 * `writeEvent` callback. All other event types pass through verbatim.
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
  const perBlockStreams = new Map<number, ReturnType<typeof createStreamDeanonymizer>>();
  const parser = createSseParser();

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
        const stream = perBlockStreams.get(idx);
        if (stream) {
          const tail = stream.end();
          perBlockStreams.delete(idx);
          if (tail.length > 0) {
            opts.writeEvent(
              "content_block_delta",
              JSON.stringify({
                type: "content_block_delta",
                index: idx,
                delta: { type: "text_delta", text: tail },
              }),
            );
          }
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
    if (
      !delta ||
      typeof delta !== "object" ||
      (delta.type !== "text_delta" && delta.type !== "text") ||
      typeof delta.text !== "string"
    ) {
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    let stream = perBlockStreams.get(index);
    if (!stream) {
      stream = createStreamDeanonymizer(opts.mappingTable);
      perBlockStreams.set(index, stream);
    }
    const emittedText = stream.write(delta.text as string);
    if (emittedText.length === 0) return;
    const patched = { ...payload, delta: { ...delta, text: emittedText } };
    opts.writeEvent(evt.event, JSON.stringify(patched));
  });

  return {
    write(chunk: string): void {
      parser.write(chunk);
    },
    end(): void {
      for (const [idx, stream] of perBlockStreams.entries()) {
        const tail = stream.end();
        if (tail.length > 0) {
          opts.writeEvent(
            "content_block_delta",
            JSON.stringify({
              type: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: tail },
            }),
          );
        }
      }
      perBlockStreams.clear();
    },
  };
}
