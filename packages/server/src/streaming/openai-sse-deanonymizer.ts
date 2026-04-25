/**
 * Pure, testable core of the OpenAI Chat-Completions SSE streaming
 * deanonymizer.
 *
 * OpenAI's chat-completions stream emits one event type — the default SSE
 * `message` event — with each `data:` payload carrying a JSON chat-completion
 * chunk:
 *
 *   data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}
 *
 *   data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":" world"}}]}
 *
 *   data: [DONE]
 *
 * Per-choice text deltas (`choices[i].delta.content`) are routed through a
 * streaming deanonymizer keyed on the choice index, so that pseudonyms split
 * across chunk boundaries are reassembled before re-emission. All other
 * fields (`role`, `tool_calls`, `function_call`, `refusal`, `finish_reason`)
 * pass through verbatim — tool-call arguments are not deanonymized to avoid
 * corrupting JSON payloads the caller will parse.
 *
 * The literal `[DONE]` sentinel is forwarded as-is. Malformed JSON is
 * forwarded verbatim so the caller can apply its own error handling.
 */

import { createStreamDeanonymizer } from "@whitestag/pii-proxy-core";
import { createSseParser } from "./sse-parser.js";

export interface OpenaiSseDeanonymizerOptions {
  mappingTable: Map<string, string>;
  writeEvent: (event: string, data: string) => void;
}

export interface OpenaiSseDeanonymizer {
  write(chunk: string): void;
  end(): void;
}

interface ChatCompletionChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: unknown;
    function_call?: unknown;
    refusal?: string | null;
  };
  finish_reason?: string | null;
}

interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: unknown;
}

const DONE_SENTINEL = "[DONE]";

export function createOpenaiSseDeanonymizer(
  opts: OpenaiSseDeanonymizerOptions,
): OpenaiSseDeanonymizer {
  // Per-choice-index stream-deanonymizers. OpenAI typically emits a single
  // choice per request (n=1 default), but n>1 is permitted and each choice's
  // delta stream is independent.
  const perChoiceStreams = new Map<number, ReturnType<typeof createStreamDeanonymizer>>();
  const parser = createSseParser();

  function flushChoice(idx: number): string {
    const stream = perChoiceStreams.get(idx);
    if (!stream) return "";
    const tail = stream.end();
    perChoiceStreams.delete(idx);
    return tail;
  }

  parser.setListener((evt) => {
    if (evt.data === DONE_SENTINEL) {
      // Final sentinel — flush any pending tails first as synthetic chunks,
      // then forward [DONE] verbatim.
      for (const [idx] of perChoiceStreams) {
        const tail = flushChoice(idx);
        if (tail.length > 0) {
          opts.writeEvent("message", JSON.stringify({
            choices: [{ index: idx, delta: { content: tail }, finish_reason: null }],
          }));
        }
      }
      opts.writeEvent(evt.event, DONE_SENTINEL);
      return;
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(evt.data) as ChatCompletionChunk;
    } catch {
      // Malformed JSON — forward verbatim and let the caller error-handle.
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      opts.writeEvent(evt.event, evt.data);
      return;
    }

    let mutated = false;
    const patchedChoices = choices.map((choice) => {
      const idx = typeof choice.index === "number" ? choice.index : 0;
      const delta = choice.delta;
      if (!delta || typeof delta.content !== "string") {
        // No content delta on this choice — handle finish_reason: flush tail
        // if the choice is closing.
        if (choice.finish_reason && perChoiceStreams.has(idx)) {
          const tail = flushChoice(idx);
          if (tail.length > 0) {
            mutated = true;
            return {
              ...choice,
              delta: { ...(delta ?? {}), content: tail },
            };
          }
        }
        return choice;
      }

      let stream = perChoiceStreams.get(idx);
      if (!stream) {
        stream = createStreamDeanonymizer(opts.mappingTable);
        perChoiceStreams.set(idx, stream);
      }
      const emittedText = stream.write(delta.content);

      // If the choice closes in this same chunk, flush its tail too.
      let combinedText = emittedText;
      if (choice.finish_reason) {
        const tail = flushChoice(idx);
        combinedText = combinedText + tail;
      }

      if (combinedText === delta.content) return choice;
      mutated = true;
      return {
        ...choice,
        delta: { ...delta, content: combinedText },
      };
    });

    const out: ChatCompletionChunk = mutated ? { ...chunk, choices: patchedChoices } : chunk;
    opts.writeEvent(evt.event, JSON.stringify(out));
  });

  return {
    write(chunk: string): void {
      parser.write(chunk);
    },
    end(): void {
      // Flush any choice whose stream is still buffering on stream-end without
      // a finish_reason or [DONE] (defensive — upstream cut). Emit each as a
      // synthetic delta chunk.
      for (const [idx] of perChoiceStreams) {
        const tail = flushChoice(idx);
        if (tail.length > 0) {
          opts.writeEvent("message", JSON.stringify({
            choices: [{ index: idx, delta: { content: tail }, finish_reason: null }],
          }));
        }
      }
    },
  };
}
