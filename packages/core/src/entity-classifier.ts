import type { Finding } from "./types.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifierResponse,
} from "./classifier-prompt.js";

export interface ClassifierConfig {
  url: string;
  model: string;
  /**
   * Optionales Fallback-Modell für den Fall, dass das Primärmodell nicht
   * klassifizieren kann (nachts ist z. B. die RTX aus → `gemma-4-12b-qat`
   * unerreichbar). Scheitert das Primärmodell mit `ClassifierUnavailableError`
   * (auch nach Retries), wird EINMAL das Fallback-Modell mit eigenen Retries
   * versucht. Muss ein Modell sein, das rund um die Uhr geladen ist
   * (z. B. das Studio-residente `google/gemma-4-12b`).
   */
  fallbackModel?: string;
  timeoutMs: number;
  /**
   * Anzahl zusätzlicher Wiederholungen bei *transienten* Classifier-Fehlern
   * (Timeout/Netzwerk/HTTP 5xx), bevor fail-closed greift. Default: 0
   * (= altes Verhalten, ein einziger Versuch). Schützt gegen das geteilte
   * LM-Studio-Modell, das unter Last kurzzeitig sättigt und timeoutet.
   */
  retries?: number;
  /** Basis-Backoff in ms zwischen den Versuchen (linear * Versuchsnr.). Default: 1500. */
  retryBackoffMs?: number;
  /**
   * Reasoning-Budget des Klassifikator-Modells. Die Entitäten-Extraktion
   * braucht kein Chain-of-Thought — auf `gemma-4-12b-qat` gemessen: 1920
   * reasoning-Tokens / 37,3 s pro 4000-Zeichen-Chunk mit Reasoning gegen
   * 0 Tokens / 13,7 s mit `"none"`, bei identischen Findings. Bei ~59 Chunks
   * je Agenten-Prompt entscheidet das darüber, ob die Anfrage im
   * Client-Timeout bleibt. Nicht gesetzt = Feld wird weggelassen (Verhalten
   * unverändert, für Server die `reasoning_effort` nicht kennen).
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

export class ClassifierUnavailableError extends Error {
  /** true, wenn ein erneuter Versuch sinnvoll ist (Timeout/Netzwerk/5xx). */
  readonly retryable: boolean;
  constructor(reason: string, retryable = false) {
    super(`classifier_unavailable: ${reason}`);
    this.retryable = retryable;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Classifier-Aufruf mit beschränktem Retry bei transienten Fehlern.
 *
 * Transient (= retrybar): Timeout/Netzwerk (`fetch_failed`) und HTTP 5xx —
 * typisch wenn das geteilte gemma-Modell gerade für einen anderen Agenten
 * generiert. Nicht-transient (HTTP 4xx, `invalid_json`, `schema_mismatch`)
 * scheitert sofort fail-closed, da ein Retry dort nichts verbessert.
 */
export async function classifyEntities(
  text: string,
  cfg: ClassifierConfig,
): Promise<Finding[]> {
  // Modell-Reihenfolge: Primär, dann (falls gesetzt) Fallback. Scheitert das
  // Primärmodell mit ClassifierUnavailableError — inkl. „Modell nicht geladen"
  // (RTX nachts aus) —, wird das Fallback-Modell versucht. Andere Fehler werden
  // nicht maskiert.
  const models = [cfg.model];
  if (cfg.fallbackModel && cfg.fallbackModel !== cfg.model) {
    models.push(cfg.fallbackModel);
  }
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await classifyWithRetries(text, cfg, model);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ClassifierUnavailableError)) throw err;
      // Classifier-Ausfall -> nächstes Modell (Fallback) probieren.
    }
  }
  throw lastErr;
}

/** Ein Modell mit dem konfigurierten Retry-Verhalten klassifizieren. */
async function classifyWithRetries(
  text: string,
  cfg: ClassifierConfig,
  model: string,
): Promise<Finding[]> {
  const maxRetries = Math.max(0, cfg.retries ?? 0);
  const backoffMs = cfg.retryBackoffMs ?? 1500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await attemptClassify(text, cfg, model);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ClassifierUnavailableError && err.retryable;
      if (!retryable || attempt === maxRetries) break;
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

async function attemptClassify(
  text: string,
  cfg: ClassifierConfig,
  model: string,
): Promise<Finding[]> {
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        stream: false,
        ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
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
    // Netzwerkfehler & Timeout (AbortError) sind transient -> retrybar.
    throw new ClassifierUnavailableError(`fetch_failed: ${(err as Error).message}`, true);
  }

  if (!response.ok) {
    // 5xx = serverseitig/Last (z. B. Modell lädt/sättigt) -> retrybar; 4xx nicht.
    throw new ClassifierUnavailableError(`http_${response.status}`, response.status >= 500);
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
