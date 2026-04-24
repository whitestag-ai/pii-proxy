/**
 * Streaming deanonymizer — reconstructs plaintext from a live stream of
 * delta chunks that may split pseudonyms across chunk boundaries.
 *
 * The algorithm's core invariant:
 *
 *   **Never emit text that might be part of an incomplete pseudonym.**
 *
 * Concretely: whenever the accumulated buffer contains a `[` that has not
 * yet been resolved (either to a closing `]` or to a literal via the
 * max-length timeout), every character from that `[` onward is held in
 * the remainder until a decision can be made. Text BEFORE the `[` is
 * safe to emit immediately.
 *
 * This keeps the client-observable stream free of partial pseudonyms while
 * preserving streaming latency for the bulk of the text.
 *
 * @module
 */

/** Longest pseudonym we ever expect: `[GESCHAEFTSGEHEIMNIS_XXXX]` is ~26 chars.
 *  We use 40 as a conservative upper bound that still fails fast. */
const DEFAULT_MAX_PSEUDO_LEN = 40;

/**
 * Pseudonym format produced by `anonymizeText`:
 *   `[TYPE_LABEL]` where
 *     TYPE  = A-Z, 0-9, _  (may contain underscore, e.g. UST_ID, ART_9)
 *     `_`  = separator (the LAST underscore before `]`)
 *     LABEL = A-Z only (A, B, ..., Z, AA, AB, ...)
 *
 * The strict pattern: opening `[`, then at least one char of [A-Z0-9_],
 * then `_`, then at least one A-Z, then closing `]`.
 *
 * We accept uppercase letters, digits, and underscore in the body. The
 * LABEL portion (after the last `_`) must be all A-Z.
 */
const PSEUDONYM_RE = /\[[A-Z0-9_]+_[A-Z]+\]/;

export interface ExtractSafePrefixOptions {
  maxPseudoLen?: number;
}

export interface ExtractSafePrefixResult {
  /** Text that can safely be emitted downstream. */
  emit: string;
  /** Suffix to carry forward to the next delta. */
  remainder: string;
  /** When true, the caller should treat this as a full-flush boundary. */
  flushAll?: boolean;
}

/**
 * Pure single-shot function: given the current accumulated buffer and the
 * mapping table, return the longest safely-emittable prefix and the
 * remainder that must stay held for the next delta.
 *
 * Safety properties (enforced by tests):
 *   - No `[` character leaks into the emitted prefix unless it was resolved
 *     (either replaced with plaintext or confirmed literal by timeout).
 *   - Known pseudonyms are always fully replaced.
 *   - Unknown `[…]` sequences are passed through verbatim (not leaked to
 *     the caller as pseudonyms, just literal brackets).
 *
 * @param buffer      the accumulated text (previous remainder + new delta)
 * @param mappings    pseudonym → plaintext lookup (keys include brackets)
 * @param options     configuration (max-len timeout for literal `[`)
 */
export function extractSafePrefix(
  buffer: string,
  mappings: Map<string, string>,
  options: ExtractSafePrefixOptions = {},
): ExtractSafePrefixResult {
  const maxPseudoLen = options.maxPseudoLen ?? DEFAULT_MAX_PSEUDO_LEN;

  let emit = "";
  let rest = buffer;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = rest.indexOf("[");
    if (openIdx === -1) {
      // No more '[' — everything is safe to emit.
      emit += rest;
      rest = "";
      break;
    }

    // Everything before the '[' is safe to emit.
    emit += rest.slice(0, openIdx);
    rest = rest.slice(openIdx);
    // rest now starts with '['

    const closeIdx = rest.indexOf("]");
    const innerOpenIdx = rest.indexOf("[", 1);

    // If another '[' appears before the first ']', the outer '[' cannot
    // be a pseudonym (pseudonyms contain no '['). Emit '[' as literal and
    // re-scan from position 1.
    if (innerOpenIdx !== -1 && (closeIdx === -1 || innerOpenIdx < closeIdx)) {
      emit += rest.charAt(0);
      rest = rest.slice(1);
      continue;
    }

    if (closeIdx === -1) {
      // No closing ']' yet AND no inner '[' competing.
      if (rest.length >= maxPseudoLen) {
        // Waited long enough — treat '[' as literal.
        emit += rest.charAt(0);
        rest = rest.slice(1);
        continue;
      }
      // Still might become a pseudonym — hold.
      break;
    }

    // We have a complete `[...]` candidate with no inner '['.
    const candidate = rest.slice(0, closeIdx + 1);

    if (PSEUDONYM_RE.test(candidate) && mappings.has(candidate)) {
      // Known pseudonym — replace and continue scanning after it.
      emit += mappings.get(candidate)!;
      rest = rest.slice(closeIdx + 1);
      continue;
    }

    // Valid-format pseudonym that is NOT in mappings, OR malformed `[...]`
    // (e.g. markdown link, RFC reference) → pass through literally.
    emit += candidate;
    rest = rest.slice(closeIdx + 1);
  }

  return { emit, remainder: rest };
}

/**
 * End-of-stream flush: the upstream said it is done. Any held-back `[` that
 * never got a closing `]` is treated as literal and emitted verbatim. Any
 * complete pseudonym in the remainder is still deanonymized.
 */
export function flushStreamRemainder(
  remainder: string,
  mappings: Map<string, string>,
): string {
  // Pass: deanonymize any complete pseudonyms, leave the rest as literal.
  const result = extractSafePrefix(remainder, mappings, {
    // At flush time, we don't hold anything back — every '[' that hasn't
    // closed yet is definitively literal.
    maxPseudoLen: 0,
  });
  // With maxPseudoLen=0, the loop above flushes '[' immediately. So
  // remainder should be "" after the pass.
  return result.emit + result.remainder;
}

/**
 * Streaming wrapper that keeps the rolling buffer internally.
 *
 * Usage:
 *   const s = createStreamDeanonymizer(mappings);
 *   for each upstream delta: `emit = s.write(delta)`; send `emit` to client
 *   on stream end:         `tail = s.end()`; send `tail` to client
 */
export interface StreamDeanonymizer {
  write(delta: string): string;
  end(): string;
}

export function createStreamDeanonymizer(
  mappings: Map<string, string>,
  options: ExtractSafePrefixOptions = {},
): StreamDeanonymizer {
  let buffer = "";
  return {
    write(delta: string): string {
      buffer += delta;
      const { emit, remainder } = extractSafePrefix(buffer, mappings, options);
      buffer = remainder;
      return emit;
    },
    end(): string {
      const tail = flushStreamRemainder(buffer, mappings);
      buffer = "";
      return tail;
    },
  };
}
