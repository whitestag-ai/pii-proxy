import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

/**
 * Chunked LLM-Klassifikation mit Per-Chunk-Cache.
 *
 * Warum: Der genaue Klassifikator (gemma) bricht ein, wenn er den GESAMTEN
 * Agenten-Prompt (riesiger statischer System-/Skills-Kontext) in EINEM Aufruf
 * klassifizieren soll — er läuft in den Timeout und der Proxy schließt fail-
 * closed. Stattdessen wird der Klassifikator-Input an SICHEREN Grenzen (Absatz
 * › Zeile › Satzende) in kleine Chunks geschnitten. Jeder Chunk wird per
 * sha256 gehasht und in einem TTL/LRU-Cache gehalten. Der identische statische
 * Prefix wird damit nur einmal je eindeutigem Chunk klassifiziert und danach
 * aus dem Cache bedient; dynamische Nachrichten-Chunks sind klein und schnell.
 *
 * Regex-Detektoren (EMAIL/PHONE/IBAN/PLZ …) laufen NICHT hier, sondern weiter
 * auf dem Volltext — Chunking betrifft nur die LLM-Entitäten (PERSON/FIRMA/
 * ORT/ART_9/GESCHAEFTSGEHEIMNIS). An Absatz-/Satzgrenzen zu schneiden stellt
 * sicher, dass kurze Entitäten (Namen, Orte, Firmen) nicht zerschnitten werden.
 */

/** Ziel-Maximalgröße eines Chunks in Zeichen. */
export const MAX_CHUNK_CHARS = 4000;
/** Default-Lebensdauer eines Cache-Eintrags (1h). */
export const CACHE_TTL_MS = 60 * 60 * 1000;
/** Maximale Anzahl Cache-Einträge (LRU-Eviction). */
export const CACHE_MAX_ENTRIES = 512;

export type ChunkClassifier = (chunk: string) => Promise<Finding[]>;

export interface ChunkCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Injizierbare Uhr (ms). Default: Date.now. Für Tests deterministisch. */
  clock?: () => number;
}

interface CacheEntry {
  findings: Finding[];
  expiresAt: number;
}

/**
 * In-Memory-Cache: Chunk-Hash → Findings. TTL-basierte Expiry plus LRU-artige
 * Eviction über eine `Map` (Einfügereihenfolge = Verwendungsreihenfolge; bei
 * jedem HIT wird der Eintrag ans Ende re-inserted).
 */
export class ChunkClassifierCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly map = new Map<string, CacheEntry>();

  constructor(opts: ChunkCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? CACHE_MAX_ENTRIES;
    this.clock = opts.clock ?? Date.now;
  }

  get(hash: string): Finding[] | undefined {
    const entry = this.map.get(hash);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.map.delete(hash);
      return undefined;
    }
    // LRU: als zuletzt verwendet markieren (ans Ende verschieben).
    this.map.delete(hash);
    this.map.set(hash, entry);
    return entry.findings;
  }

  set(hash: string, findings: Finding[]): void {
    if (this.map.has(hash)) this.map.delete(hash);
    this.map.set(hash, { findings, expiresAt: this.clock() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

function hashChunk(chunk: string): string {
  return createHash("sha256").update(chunk, "utf8").digest("hex");
}

/**
 * Teilt `text` an SICHEREN Grenzen in Chunks von höchstens `maxChars` Zeichen.
 * Bevorzugte Grenzen, von grob nach fein: Doppel-Zeilenumbruch (Absatz),
 * einfacher Zeilenumbruch, Satzende. So wird keine kurze Entität (Name, Ort,
 * Firma) an einer Grenze zerschnitten.
 *
 * Hinweis: Sehr lange einzelne Segmente ohne jede Grenze werden als letzter
 * Ausweg hart geschnitten — das betrifft nur pathologische Eingaben ohne
 * Whitespace und ist für reale Prompts irrelevant.
 */
export function splitIntoChunks(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return text.length === 0 ? [] : [text];

  // Erst grob an Absätzen segmentieren, Trenner erhalten (verlustfrei).
  const segments = splitKeepingSeparators(text, /\n\n+/g);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const seg of segments) {
    if (current.length + seg.length <= maxChars) {
      current += seg;
      continue;
    }
    // current voll -> abschließen, dann seg betrachten.
    flush();
    if (seg.length <= maxChars) {
      current = seg;
    } else {
      for (const sub of splitLargeSegment(seg, maxChars)) chunks.push(sub);
    }
  }
  flush();
  return chunks;
}

/** Zerlegt ein zu großes Segment an Zeilen-, dann Satzgrenzen. */
function splitLargeSegment(seg: string, maxChars: number): string[] {
  return packPieces(splitKeepingSeparators(seg, /\n+/g), maxChars, (piece) =>
    piece.length <= maxChars ? [piece] : splitBySentences(piece, maxChars),
  );
}

/** Zerlegt eine zu lange Zeile an Satzenden, sonst hart. */
function splitBySentences(line: string, maxChars: number): string[] {
  return packPieces(splitKeepingSeparators(line, /(?<=[.!?])\s+/g), maxChars, (piece) =>
    piece.length <= maxChars ? [piece] : hardSplit(piece, maxChars),
  );
}

function hardSplit(s: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  return out;
}

/**
 * Packt eine Liste von Teil-Strings greedy in Chunks ≤ maxChars. Teile, die
 * selbst zu groß sind, werden über `overflow` weiter zerlegt.
 */
function packPieces(
  pieces: string[],
  maxChars: number,
  overflow: (piece: string) => string[],
): string[] {
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      out.push(current);
      current = "";
    }
  };
  for (const piece of pieces) {
    if (current.length + piece.length <= maxChars) {
      current += piece;
      continue;
    }
    flush();
    if (piece.length <= maxChars) {
      current = piece;
    } else {
      for (const sub of overflow(piece)) {
        if (sub.length <= maxChars) {
          if (current.length + sub.length <= maxChars) {
            current += sub;
          } else {
            flush();
            current = sub;
          }
        } else {
          flush();
          out.push(sub);
        }
      }
    }
  }
  flush();
  return out;
}

/**
 * Splittet `text` am `separator`-Regex, behält die Trenner aber im jeweils
 * vorangehenden Stück, sodass `chunks.join("")` === `text` (verlustfrei).
 */
function splitKeepingSeparators(text: string, separator: RegExp): string[] {
  const re = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : separator.flags + "g");
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    out.push(text.slice(last, end));
    last = end;
    if (m.index === re.lastIndex) re.lastIndex++; // Schutz gegen Endlosschleife
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Klassifiziert `text` chunked + cached und liefert die zusammengeführten,
 * nach (type, value) deduplizierten Findings. Jeder Finding-`value` ist ein
 * exakter Substring eines Chunks und damit des Volltexts — die wertbasierte
 * Anonymisierung bleibt unverändert korrekt. `start`/`end` werden gegen den
 * Volltext neu berechnet (erstes Vorkommen).
 *
 * Cache-HIT → Findings wiederverwenden, KEIN Klassifikator-Aufruf. MISS → den
 * übergebenen `classify` für genau diesen Chunk aufrufen und die Findings unter
 * dem Chunk-Hash ablegen.
 */
export async function classifyEntitiesChunked(
  text: string,
  classify: ChunkClassifier,
  cache: ChunkClassifierCache,
): Promise<Finding[]> {
  const chunks = splitIntoChunks(text);

  // type+value -> Finding (Dedup). Erstes Auftreten gewinnt; bei höherer
  // Confidence eines späteren Duplikats wird hochgestuft (konservativ).
  const merged = new Map<string, Finding>();
  const rank: Record<Finding["confidence"], number> = { low: 0, medium: 1, high: 2 };

  for (const chunk of chunks) {
    const hash = hashChunk(chunk);
    let findings = cache.get(hash);
    if (findings === undefined) {
      findings = await classify(chunk);
      cache.set(hash, findings);
    }
    for (const f of findings) {
      // value muss exakter Substring des Volltexts sein, sonst verwerfen
      // (defensive Übereinstimmung mit dem entity-classifier-Verhalten).
      const start = text.indexOf(f.value);
      if (start < 0) continue;
      const normalized: Finding = {
        ...f,
        start,
        end: start + f.value.length,
      };
      const key = `${f.type} ${f.value}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, normalized);
      } else if (rank[normalized.confidence] > rank[existing.confidence]) {
        merged.set(key, normalized);
      }
    }
  }

  return [...merged.values()];
}
