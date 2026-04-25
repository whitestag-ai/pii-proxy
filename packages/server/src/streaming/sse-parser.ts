/**
 * Minimal Server-Sent Events (SSE) frame parser.
 *
 * Handles the subset of the SSE spec that Anthropic, OpenAI, and most LLM
 * providers emit:
 *   - `event: <name>` (optional; defaults to "message")
 *   - `data: <payload>` (one or more lines — joined with "\n")
 *   - `:comment` lines are ignored
 *   - `id:` / `retry:` / other field names are parsed but dropped
 *   - events are terminated by a blank line (`\n\n` or `\r\n\r\n`)
 *
 * The parser is push-based: feed it raw string chunks via `write()`, and it
 * invokes the current listener for each complete event in order. Incomplete
 * trailing data is held in an internal buffer until the next `write()`.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseParser {
  write(chunk: string): void;
  setListener(listener: (event: SseEvent) => void): void;
  /** Reset internal buffer (e.g. on upstream disconnect). */
  reset(): void;
}

export function createSseParser(): SseParser {
  let buffer = "";
  let listener: ((event: SseEvent) => void) | null = null;

  function emit(frame: string): void {
    if (!listener) return;
    const lines = frame.split("\n");

    let eventName = "message";
    let dataLines: string[] | null = null;

    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      if (line.startsWith(":")) continue; // comment
      const colonIdx = line.indexOf(":");
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colonIdx);
        value = line.slice(colonIdx + 1);
        if (value.startsWith(" ")) value = value.slice(1);
      }
      switch (field) {
        case "event":
          eventName = value;
          break;
        case "data":
          if (dataLines === null) dataLines = [];
          dataLines.push(value);
          break;
        // ignore id, retry, and any unknown field
      }
    }

    if (dataLines === null) return; // empty event with no data — swallow
    listener({ event: eventName, data: dataLines.join("\n") });
  }

  function drain(): void {
    // Look for blank-line frame terminators. Support both \n\n and \r\n\r\n.
    while (true) {
      const idxLf = buffer.indexOf("\n\n");
      const idxCrlf = buffer.indexOf("\r\n\r\n");
      let end: number;
      let sepLen: number;
      if (idxLf === -1 && idxCrlf === -1) return;
      if (idxLf === -1) {
        end = idxCrlf!;
        sepLen = 4;
      } else if (idxCrlf === -1) {
        end = idxLf;
        sepLen = 2;
      } else {
        // Whichever is earlier.
        if (idxCrlf < idxLf) {
          end = idxCrlf;
          sepLen = 4;
        } else {
          end = idxLf;
          sepLen = 2;
        }
      }
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + sepLen);
      if (frame.length > 0) emit(frame);
    }
  }

  return {
    write(chunk: string): void {
      buffer += chunk;
      drain();
    },
    setListener(l: (event: SseEvent) => void): void {
      listener = l;
    },
    reset(): void {
      buffer = "";
    },
  };
}
