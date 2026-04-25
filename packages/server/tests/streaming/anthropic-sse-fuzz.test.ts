/**
 * Fuzz test: for a fixed upstream SSE byte sequence, randomly re-chunk it
 * N times and verify that the deanonymized text content is identical
 * across every chunking. This is the key safety guarantee for streaming
 * PII rewrite — boundary placement must never change the output.
 */

import { describe, it, expect } from "vitest";
import { createAnthropicSseDeanonymizer } from "../../src/streaming/anthropic-sse-deanonymizer.js";

function mk(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

function buildSseStream(text: string, index = 0): string {
  // Split text into arbitrary-length "tokens" to simulate Anthropic
  // streaming deltas. We make the split deterministic per text length.
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const stride = 1 + ((i * 31 + 7) % 5); // 1..5 chars per delta
    tokens.push(text.slice(i, i + stride));
    i += stride;
  }
  let sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  sse += `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}\n\n`;
  for (const t of tokens) {
    sse +=
      "event: content_block_delta\ndata: " +
      JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: t },
      }) +
      "\n\n";
  }
  sse += `event: content_block_stop\ndata: {"index":${index}}\n\n`;
  sse += 'event: message_delta\ndata: {"type":"message_delta"}\n\n';
  sse += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  return sse;
}

function deanonymizeWithChunking(
  sse: string,
  chunkBoundaries: number[],
  mappings: Map<string, string>,
): string {
  const events: Array<{ event: string; data: string }> = [];
  const pipeline = createAnthropicSseDeanonymizer({
    mappingTable: mappings,
    writeEvent: (event, data) => events.push({ event, data }),
  });

  let cursor = 0;
  for (const end of [...chunkBoundaries, sse.length]) {
    const chunk = sse.slice(cursor, end);
    if (chunk.length > 0) pipeline.write(chunk);
    cursor = end;
  }
  pipeline.end();

  // Reconstruct text from all content_block_delta events (index 0).
  let text = "";
  for (const e of events) {
    if (e.event !== "content_block_delta") continue;
    try {
      const payload = JSON.parse(e.data);
      if (payload.index !== 0) continue;
      const delta = payload.delta;
      if (delta && (delta.type === "text_delta" || delta.type === "text") && typeof delta.text === "string") {
        text += delta.text;
      }
    } catch {
      /* ignore */
    }
  }
  return text;
}

function randomBoundaries(length: number, seed: number): number[] {
  const result: number[] = [];
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  let pos = 0;
  while (pos < length) {
    const stride = 1 + Math.floor(rand() * 25); // 1..25
    pos += stride;
    if (pos < length) result.push(pos);
  }
  return result;
}

describe("fuzz: random chunk boundaries yield identical deanonymized text", () => {
  const SCENARIOS: Array<{
    label: string;
    mappings: Array<[string, string]>;
    sourceText: string;
    expected: string;
  }> = [
    {
      label: "single PERSON pseudonym",
      mappings: [["[PERSON_A]", "Max Mustermann"]],
      sourceText: "Hallo [PERSON_A], wie geht es Ihnen heute?",
      expected: "Hallo Max Mustermann, wie geht es Ihnen heute?",
    },
    {
      label: "two pseudonyms of different types",
      mappings: [
        ["[PERSON_A]", "Erika Beispiel"],
        ["[EMAIL_A]", "erika@beispiel.de"],
      ],
      sourceText: "Bitte kontaktiere [PERSON_A] unter [EMAIL_A] bis Freitag.",
      expected: "Bitte kontaktiere Erika Beispiel unter erika@beispiel.de bis Freitag.",
    },
    {
      label: "pseudonym with underscore in TYPE (UST_ID)",
      mappings: [["[UST_ID_A]", "DE123456789"]],
      sourceText: "USt-ID des Kunden: [UST_ID_A]. Danke.",
      expected: "USt-ID des Kunden: DE123456789. Danke.",
    },
    {
      label: "ART_9 pseudonym (digit in TYPE)",
      mappings: [["[ART_9_A]", "(redacted)"]],
      sourceText: "Hinweis: [ART_9_A] — bitte intern prüfen.",
      expected: "Hinweis: (redacted) — bitte intern prüfen.",
    },
    {
      label: "multi-letter label (AA) and repeated same pseudonym",
      mappings: [
        ["[PERSON_A]", "Max"],
        ["[PERSON_AA]", "Alice"],
      ],
      sourceText: "[PERSON_A] schreibt an [PERSON_AA]. Später antwortet [PERSON_A] erneut.",
      expected: "Max schreibt an Alice. Später antwortet Max erneut.",
    },
    {
      label: "long paragraph with 4 pseudonyms",
      mappings: [
        ["[PERSON_A]", "Max Mustermann"],
        ["[FIRMA_A]", "WHITESTAG.AI"],
        ["[IBAN_A]", "DE89 3704 0044 0532 0130 00"],
        ["[EMAIL_A]", "max.mustermann@example.de"],
      ],
      sourceText:
        "Sehr geehrter [PERSON_A], wir danken Ihnen für den Auftrag von [FIRMA_A]. " +
        "Bitte überweisen Sie den offenen Betrag auf [IBAN_A]. Rückfragen gerne an [EMAIL_A]. " +
        "Wir freuen uns auf die weitere Zusammenarbeit mit [PERSON_A].",
      expected:
        "Sehr geehrter Max Mustermann, wir danken Ihnen für den Auftrag von WHITESTAG.AI. " +
        "Bitte überweisen Sie den offenen Betrag auf DE89 3704 0044 0532 0130 00. Rückfragen gerne an max.mustermann@example.de. " +
        "Wir freuen uns auf die weitere Zusammenarbeit mit Max Mustermann.",
    },
    {
      label: "unmapped well-formed pseudonym stays literal (PERSON_Z not in map)",
      mappings: [["[PERSON_A]", "Max"]],
      sourceText: "[PERSON_A] trifft [PERSON_Z] am Mittag.",
      expected: "Max trifft [PERSON_Z] am Mittag.",
    },
    {
      label: "brackets that are NOT pseudonyms pass through literal",
      mappings: [["[PERSON_A]", "Max"]],
      sourceText: "See [RFC_2119] or section [3.2.1] for details, Max [PERSON_A].",
      expected: "See [RFC_2119] or section [3.2.1] for details, Max Max.",
    },
  ];

  const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67];

  for (const scenario of SCENARIOS) {
    it(`${scenario.label} — stable across ${SEEDS.length} random chunkings`, () => {
      const mappings = mk(scenario.mappings);
      const sse = buildSseStream(scenario.sourceText, 0);

      // Reference: one-shot (single write)
      const referenceOut = deanonymizeWithChunking(sse, [], mappings);
      expect(referenceOut).toBe(scenario.expected);

      // Fuzz: every seed produces the SAME output
      for (const seed of SEEDS) {
        const boundaries = randomBoundaries(sse.length, seed);
        const out = deanonymizeWithChunking(sse, boundaries, mappings);
        if (out !== referenceOut) {
          // Helpful failure message: include seed for reproducibility
          throw new Error(
            `fuzz mismatch for scenario '${scenario.label}' seed=${seed}: got ${JSON.stringify(
              out,
            )}, expected ${JSON.stringify(referenceOut)}`,
          );
        }
      }
    });
  }

  it("pathological: byte-by-byte chunking still yields identical output", () => {
    const mappings = mk([
      ["[PERSON_A]", "Alice"],
      ["[EMAIL_A]", "alice@example.com"],
    ]);
    const source = "Kurznachricht an [PERSON_A] ([EMAIL_A]): bitte prüfen.";
    const expected = "Kurznachricht an Alice (alice@example.com): bitte prüfen.";
    const sse = buildSseStream(source, 0);
    // boundaries at every single byte
    const boundaries: number[] = [];
    for (let i = 1; i < sse.length; i++) boundaries.push(i);
    const out = deanonymizeWithChunking(sse, boundaries, mappings);
    expect(out).toBe(expected);
  });
});
