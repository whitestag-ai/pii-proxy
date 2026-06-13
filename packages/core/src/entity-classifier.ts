import type { Finding } from "./types.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifierResponse,
} from "./classifier-prompt.js";

export interface ClassifierConfig {
  url: string;
  model: string;
  timeoutMs: number;
}

export class ClassifierUnavailableError extends Error {
  constructor(reason: string) {
    super(`classifier_unavailable: ${reason}`);
  }
}

export async function classifyEntities(
  text: string,
  cfg: ClassifierConfig,
): Promise<Finding[]> {
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ClassifierResponse",
            strict: true,
            schema: {
              type: "object",
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["PERSON", "FIRMA", "ORT", "GESCHAEFTSGEHEIMNIS", "ART_9"],
                      },
                      value: { type: "string" },
                      confidence: {
                        type: "string",
                        enum: ["low", "medium", "high"],
                      },
                    },
                    required: ["type", "value", "confidence"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["findings"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new ClassifierUnavailableError(`fetch_failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    throw new ClassifierUnavailableError(`http_${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content?: string | null; reasoning_content?: string | null } }>;
  };
  const message = data.choices[0]?.message;
  const content = message?.content ?? "";

  // Reasoning models (z. B. qwen3.6) liefern die JSON-Antwort teils nur im
  // `reasoning_content`, während `content` leer/whitespace ist. Dann auf das
  // Reasoning-Feld zurückfallen und das JSON tolerant extrahieren.
  const rawText = content.trim().length > 0 ? content : (message?.reasoning_content ?? "");

  const parsed = parseClassifierResponse(rawText);
  if (parsed === null) {
    throw new ClassifierUnavailableError("invalid_json");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new ClassifierUnavailableError("schema_mismatch");
  }

  const findings: Finding[] = [];
  for (const f of parsed.findings) {
    const start = text.indexOf(f.value);
    if (start < 0) continue;
    findings.push({
      type: f.type,
      value: f.value,
      start,
      end: start + f.value.length,
      confidence: f.confidence,
      source: "llm",
    });
  }
  return findings;
}

/**
 * Parst die Klassifikator-Antwort tolerant. Erst direkter JSON.parse; schlägt
 * das fehl (z. B. weil ein Reasoning-Modell das JSON in Thinking-Tags / Prosa
 * gewickelt hat), wird die größte zusammenhängende JSON-Objekt-/Array-Spanne
 * extrahiert (erstes `{`/`[` bis zum letzten `}`/`]`) und nochmal geparst.
 *
 * Liefert das geparste Objekt oder `null`, wenn nichts Parsebares gefunden
 * wurde — der Aufrufer behält dann sein fail-closed-Verhalten bei.
 */
function parseClassifierResponse(raw: string): ClassifierResponse | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const direct = tryParse(text);
  if (direct !== null) return direct;

  // Tolerant: kleinster Index eines öffnenden { oder [, bis zum jeweils
  // passenden letzten schließenden Zeichen.
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const candidates: Array<[number, number]> = [];
  if (firstBrace >= 0) candidates.push([firstBrace, text.lastIndexOf("}")]);
  if (firstBracket >= 0) candidates.push([firstBracket, text.lastIndexOf("]")]);
  // Bevorzuge die früher beginnende Spanne (umschließt typischerweise das Ganze).
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, end] of candidates) {
    if (end > start) {
      const sub = tryParse(text.slice(start, end + 1));
      if (sub !== null) return sub;
    }
  }
  return null;
}

function tryParse(s: string): ClassifierResponse | null {
  try {
    return JSON.parse(s) as ClassifierResponse;
  } catch {
    return null;
  }
}
