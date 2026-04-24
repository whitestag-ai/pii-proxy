import { describe, it, expect } from "vitest";
import {
  extractSafePrefix,
  flushStreamRemainder,
  createStreamDeanonymizer,
} from "../src/stream-deanonymizer.js";

// Helper: build a minimal mapping table for tests.
function mk(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe("extractSafePrefix — pure function", () => {
  it("passes through plain text with no '[' untouched", () => {
    const r = extractSafePrefix("Hello world, no pseudonyms here.", mk([]));
    expect(r.emit).toBe("Hello world, no pseudonyms here.");
    expect(r.remainder).toBe("");
  });

  it("replaces a complete pseudonym when present in the mapping", () => {
    const map = mk([["[PERSON_A]", "Max Mustermann"]]);
    const r = extractSafePrefix("Hello [PERSON_A], welcome.", map);
    expect(r.emit).toBe("Hello Max Mustermann, welcome.");
    expect(r.remainder).toBe("");
  });

  it("replaces multiple pseudonyms in one buffer", () => {
    const map = mk([
      ["[PERSON_A]", "Max"],
      ["[EMAIL_A]", "max@example.de"],
    ]);
    const r = extractSafePrefix("Schreibe [PERSON_A] an [EMAIL_A].", map);
    expect(r.emit).toBe("Schreibe Max an max@example.de.");
    expect(r.remainder).toBe("");
  });

  it("holds back an unclosed '[' at end of buffer (pseudonym might still be forming)", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const r = extractSafePrefix("Hi [PER", map);
    expect(r.emit).toBe("Hi ");
    expect(r.remainder).toBe("[PER");
    expect(r.flushAll).toBeFalsy();
  });

  it("holds back '[' with partial content through multiple deltas, then resolves on close", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    // Delta 1: "Hi [PER"
    let r1 = extractSafePrefix("Hi [PER", map);
    expect(r1.emit).toBe("Hi ");
    expect(r1.remainder).toBe("[PER");
    // Delta 2 arrives, buffer becomes "[PERSON_A] cool"
    const r2 = extractSafePrefix(r1.remainder + "SON_A] cool", map);
    expect(r2.emit).toBe("Max cool");
    expect(r2.remainder).toBe("");
  });

  it("handles pseudonym split across 3 deltas", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const s1 = extractSafePrefix("[", map);
    expect(s1.emit).toBe("");
    expect(s1.remainder).toBe("[");
    const s2 = extractSafePrefix(s1.remainder + "PERSON", map);
    expect(s2.emit).toBe("");
    expect(s2.remainder).toBe("[PERSON");
    const s3 = extractSafePrefix(s2.remainder + "_A]", map);
    expect(s3.emit).toBe("Max");
    expect(s3.remainder).toBe("");
  });

  it("after maxPseudoLen chars past '[' without ']' flushes '[' as literal", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    // 45 chars of junk after '[' → definitely not a pseudonym
    const buf = "[abc def ghi jkl mno pqr stu vwx yz ABC DEF GHI";
    const r = extractSafePrefix(buf, map, { maxPseudoLen: 40 });
    // '[' was literal — emit '[' and continue with the rest
    expect(r.emit.startsWith("[")).toBe(true);
    expect(r.emit).toBe(buf);
    expect(r.remainder).toBe("");
  });

  it("keeps '[' in remainder while gap to EOB is shorter than maxPseudoLen", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    // '[' with only 5 chars following — might still be building up
    const r = extractSafePrefix("hi [PER", map, { maxPseudoLen: 40 });
    expect(r.remainder).toBe("[PER");
  });

  it("treats unknown [...] as literal (not in mapping) and passes through", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const r = extractSafePrefix("See [RFC_2119] for details", map);
    // [RFC_2119] doesn't match our format (LABEL must be A-Z only, not digits) — literal
    expect(r.emit).toBe("See [RFC_2119] for details");
    expect(r.remainder).toBe("");
  });

  it("treats a valid-format but unmapped pseudonym as literal", () => {
    // [PERSON_Z] looks like a pseudonym but is not in our mapping
    const map = mk([["[PERSON_A]", "Max"]]);
    const r = extractSafePrefix("Stranger: [PERSON_Z]", map);
    expect(r.emit).toBe("Stranger: [PERSON_Z]");
    expect(r.remainder).toBe("");
  });

  it("handles pseudonyms with underscore in the TYPE part (UST_ID_A)", () => {
    const map = mk([["[UST_ID_A]", "DE123456789"]]);
    const r = extractSafePrefix("USt-ID: [UST_ID_A]", map);
    expect(r.emit).toBe("USt-ID: DE123456789");
  });

  it("handles ART_9 pseudonyms (digit + underscore in TYPE)", () => {
    const map = mk([["[ART_9_A]", "(redacted-art9)"]]);
    const r = extractSafePrefix("Warning: [ART_9_A]", map);
    expect(r.emit).toBe("Warning: (redacted-art9)");
  });

  it("handles multi-letter LABEL (AA, AB, ..., ZZ, AAA)", () => {
    const map = mk([
      ["[PERSON_AB]", "Bob"],
      ["[PERSON_AAA]", "Alice"],
    ]);
    const r = extractSafePrefix("Hi [PERSON_AB] and [PERSON_AAA]", map);
    expect(r.emit).toBe("Hi Bob and Alice");
  });

  it("flushes prefix up to (but not including) an unclosed '['", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const r = extractSafePrefix("lots of safe text before [PER", map);
    expect(r.emit).toBe("lots of safe text before ");
    expect(r.remainder).toBe("[PER");
  });

  it("handles nested '[' — outer '[' was literal, inner pseudonym replaced", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    // "[ignored [PERSON_A]" — the first '[' has no closing bracket quickly;
    // but its follower chars include another '['+complete pseudonym.
    // The algorithm should treat outer '[' as literal on max-len flush OR
    // when a fresh '[' is encountered. Simple & safe: hold '[' only when
    // it might still be building up. Here first '[' is followed by
    // "ignored " and then another "[PERSON_A]" — we give up on first
    // and emit as literal.
    const longLiteral = "[" + "x".repeat(50) + "[PERSON_A]";
    const r = extractSafePrefix(longLiteral, map, { maxPseudoLen: 40 });
    // First '[' was a false start, flushed. Second [PERSON_A] replaced.
    expect(r.emit).toBe("[" + "x".repeat(50) + "Max");
    expect(r.remainder).toBe("");
  });

  it("empty buffer returns empty emit and empty remainder", () => {
    const r = extractSafePrefix("", mk([]));
    expect(r.emit).toBe("");
    expect(r.remainder).toBe("");
  });

  it("does NOT emit past a held-back '[' even if the rest of the buffer is safe", () => {
    // Invariant: once we see '[', everything after it is held until we decide.
    const map = mk([["[PERSON_A]", "Max"]]);
    const r = extractSafePrefix("ok [PE lots of other text after", map);
    // We hold from '[' onward (might grow into a pseudonym).
    // Correct: emit "ok ", remainder = "[PE lots of other text after"
    // until the buffer grows past maxPseudoLen from the '[' OR a ']' appears.
    expect(r.emit).toBe("ok ");
    expect(r.remainder.startsWith("[PE")).toBe(true);
  });
});

describe("flushStreamRemainder — end-of-stream flush", () => {
  it("deanonymizes a complete pseudonym in the final buffer", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const flushed = flushStreamRemainder("bye [PERSON_A]", map);
    expect(flushed).toBe("bye Max");
  });

  it("emits unclosed '[' + trailing content as literal (stream ended mid-pseudonym)", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const flushed = flushStreamRemainder("never finished: [PER", map);
    expect(flushed).toBe("never finished: [PER");
  });

  it("handles empty remainder", () => {
    expect(flushStreamRemainder("", mk([]))).toBe("");
  });
});

describe("createStreamDeanonymizer — streaming wrapper", () => {
  it("delivers full text identical to a single-shot deanonymize, regardless of chunk boundaries", () => {
    const map = mk([
      ["[PERSON_A]", "Max Mustermann"],
      ["[EMAIL_A]", "max@example.de"],
      ["[IBAN_A]", "DE89 3704 0044 0532 0130 00"],
    ]);
    const full =
      "Rechnung an [PERSON_A] ([EMAIL_A]) für Beratungstag. IBAN des Kunden: [IBAN_A]. Mit freundlichen Grüßen.";

    // Split into adversarial chunks: sometimes mid-pseudonym, sometimes
    // immediately after '[', sometimes inside the LABEL part.
    const chunks = [
      "Rechnung an [P",
      "ERSON_A",
      "] ([EMAIL_",
      "A]) für Beratungstag. IBAN des Kunden: [",
      "IBAN_A]. Mit freundlichen Grüßen.",
    ];

    const stream = createStreamDeanonymizer(map);
    let emitted = "";
    for (const chunk of chunks) emitted += stream.write(chunk);
    emitted += stream.end();

    expect(emitted).toBe(
      "Rechnung an Max Mustermann (max@example.de) für Beratungstag. IBAN des Kunden: DE89 3704 0044 0532 0130 00. Mit freundlichen Grüßen.",
    );
  });

  it("character-by-character input still produces correct output", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const stream = createStreamDeanonymizer(map);
    const input = "Hi [PERSON_A], bye.";
    let emitted = "";
    for (const ch of input) emitted += stream.write(ch);
    emitted += stream.end();
    expect(emitted).toBe("Hi Max, bye.");
  });

  it("never emits a partial pseudonym mid-stream", () => {
    const map = mk([["[PERSON_A]", "Max"]]);
    const stream = createStreamDeanonymizer(map);
    // After each write, emitted output must NOT contain any '[' character
    // unless it's the start of a literal sequence that has been flushed
    // because it timed out. For a straightforward case with just PERSON_A:
    let soFar = "";
    soFar += stream.write("Hi [");
    expect(soFar).not.toContain("[");
    soFar += stream.write("PERSON");
    expect(soFar).not.toContain("[");
    soFar += stream.write("_A");
    expect(soFar).not.toContain("[");
    soFar += stream.write("]");
    soFar += stream.end();
    expect(soFar).toBe("Hi Max");
  });
});
