import { randomUUID } from "node:crypto";
import { detectPii, REGEX_ONLY_DETECTORS, type DetectorKey } from "./pii-detector.js";
import { classifyEntities, ClassifierUnavailableError, type ClassifierConfig } from "./entity-classifier.js";
import { ChunkClassifierCache, classifyEntitiesChunked } from "./classifier-chunk-cache.js";
import { EncryptedChunkCacheStore } from "./chunk-cache-store.js";
import { anonymizeText } from "./anonymizer.js";
import { deanonymizeText } from "./deanonymizer.js";
import { MappingStore } from "./mapping-store.js";
import { AuditLog, hashPrompt } from "./audit-log.js";
import { loadDefaultRules, type Rules } from "./rules.js";
import type {
  AnonymizeRequest,
  AnonymizeResponse,
  AnonymizeResult,
  AnonymizeBlocked,
  DeanonymizeRequest,
  DeanonymizeResult,
  Finding,
  Confidence,
} from "./types.js";

export type { AnonymizeRequest, AnonymizeResponse, DeanonymizeRequest, DeanonymizeResult } from "./types.js";
export { ClassifierUnavailableError } from "./entity-classifier.js";

export interface PiiProxyOptions {
  mappingDbPath: string;
  mappingKey: Buffer;
  auditDir: string;
  classifier: ClassifierConfig;
  rules?: Rules;
  /**
   * Optionaler Pfad zur persistenten (verschlüsselten) Chunk-Findings-DB.
   * Gesetzt → der statische Prompt-Prefix wird je Chunk nur EINMAL klassifiziert
   * und überlebt Proxy-Neustarts. Verschlüsselt mit `mappingKey` (at rest).
   * Fehlt der Pfad → reiner In-Memory-Cache (altes Verhalten).
   */
  chunkCacheDbPath?: string;
  /** TTL der persistenten Chunk-Einträge in Sekunden. Default: 7 Tage. */
  chunkCacheTtlSeconds?: number;
}

export interface PiiProxy {
  anonymize(req: AnonymizeRequest): Promise<AnonymizeResponse>;
  deanonymize(req: DeanonymizeRequest): DeanonymizeResult;
  /**
   * Return the pseudonym → plaintext mapping for a given mappingId.
   * Used by streaming passthroughs that need to deanonymize chunked
   * responses (where each chunk is too short for `deanonymize` to
   * match complete tokens reliably).
   *
   * Throws `MappingNotFoundError` when the mappingId is unknown.
   */
  getMappingTable(mappingId: string): Map<string, string>;
  close(): void;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

type Segment = { start: number; end: number };

function segmentsOf(req: AnonymizeRequest): Segment[] {
  return req.classifierSegments ?? [{ start: 0, end: req.text.length }];
}

/**
 * Verbindet die Classifier-Bereiche zu einem Text. Ohne Werkzeug-Bloecke entspricht
 * er dem bisherigen Gesamttext, sodass der Chunk-Cache gueltig bleibt. Die Treffer
 * des Classifiers werden auf Positionen im Gesamttext zurueckgerechnet.
 */
function joinSegments(req: AnonymizeRequest): {
  text: string;
  toFullText: (findings: Finding[]) => Finding[];
} {
  const segments = segmentsOf(req);
  const separator = req.classifierSeparator ?? "";
  const text = segments.map((s) => req.text.slice(s.start, s.end)).join(separator);
  const toFullText = (findings: Finding[]): Finding[] => {
    const out: Finding[] = [];
    for (const f of findings) {
      let offset = 0;
      for (const s of segments) {
        const length = s.end - s.start;
        if (f.start >= offset && f.end <= offset + length) {
          const shift = s.start - offset;
          out.push({ ...f, start: f.start + shift, end: f.end + shift });
          break;
        }
        offset += length + separator.length;
      }
    }
    return out;
  };
  return { text, toFullText };
}

/**
 * Ueberlappende Treffer wuerden beim Ersetzen nach Position den Text zerstoeren.
 * Die Liste beginnt mit den Regex-Treffern, die damit Vorrang behalten.
 */
function withoutOverlaps(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  }
  return kept;
}

/** Alle Regeln in den Classifier-Bereichen, dazwischen nur die strengen Muster. */
function detectRegexFindings(req: AnonymizeRequest, ruleDetectors: DetectorKey[]): Finding[] {
  const out: Finding[] = [];
  const scan = (start: number, end: number, only: DetectorKey[]): void => {
    if (end <= start) return;
    for (const f of detectPii(req.text.slice(start, end), { only })) {
      out.push({ ...f, start: f.start + start, end: f.end + start });
    }
  };
  let pos = 0;
  for (const s of segmentsOf(req)) {
    scan(pos, s.start, REGEX_ONLY_DETECTORS);
    scan(s.start, s.end, ruleDetectors);
    pos = s.end;
  }
  scan(pos, req.text.length, REGEX_ONLY_DETECTORS);
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function allOccurrences(text: string, value: string, from: number, to: number): number[] {
  const out: number[] = [];
  for (
    let at = text.indexOf(value, from);
    at >= 0 && at + value.length <= to;
    at = text.indexOf(value, at + 1)
  ) {
    const before = text[at - 1];
    const after = text[at + value.length];
    if (before && WORD_CHAR.test(before)) continue;
    if (after && WORD_CHAR.test(after)) continue;
    out.push(at);
  }
  return out;
}

/**
 * Der Classifier nennt jeden Wert nur einmal und nur mit der ersten Fundstelle. Ohne
 * diese Ausweitung gingen alle weiteren Nennungen im Klartext hinaus.
 *
 * Werkzeug-Text enthaelt Code und Pfade, in denen ein einzelnes Wort leicht zufaellig
 * passt. Dorthin wandern deshalb nur Vor- und Nachnamen: Sie muessen ersetzt werden,
 * weil das Modell den Platzhalter aus dem Auftrag sonst nicht mit der Datei verbinden kann.
 * Laengere Werte stehen vorn, damit "Max Mustermann" vor "Max" zum Zug kommt.
 */
function expandClassifierFindings(req: AnonymizeRequest, findings: Finding[]): Finding[] {
  const byValue = new Map<string, Finding>();
  for (const f of findings) byValue.set(`${f.type}::${f.value}`, f);
  const out = [...findings];
  const known = new Set(findings.map((f) => `${f.start}:${f.end}`));
  const add = (f: Finding, start: number): void => {
    const key = `${start}:${start + f.value.length}`;
    if (known.has(key)) return;
    known.add(key);
    out.push({ ...f, start, end: start + f.value.length });
  };
  for (const f of byValue.values()) {
    const intoToolText = f.type === "PERSON" && /\s/.test(f.value.trim());
    let pos = 0;
    for (const s of segmentsOf(req)) {
      if (intoToolText) {
        for (const at of allOccurrences(req.text, f.value, pos, s.start)) add(f, at);
      }
      for (const at of allOccurrences(req.text, f.value, s.start, s.end)) add(f, at);
      pos = s.end;
    }
    if (intoToolText) {
      for (const at of allOccurrences(req.text, f.value, pos, req.text.length)) add(f, at);
    }
  }
  return out.sort((a, b) => b.value.length - a.value.length || a.start - b.start);
}

export function createPiiProxy(opts: PiiProxyOptions): PiiProxy {
  const rules = opts.rules ?? loadDefaultRules();
  const store = new MappingStore({ path: opts.mappingDbPath, key: opts.mappingKey });
  const audit = new AuditLog({ dir: opts.auditDir });
  // Per-Chunk-Findings-Cache: der riesige statische System-/Skills-Kontext
  // (über Aufrufe identisch) wird je eindeutigem Chunk nur einmal klassifiziert
  // und danach aus dem Cache bedient. Eine Cache-Instanz je Proxy.
  // Optional mit persistenter, verschlüsselter L2 (überlebt Neustarts).
  const chunkCacheStore = opts.chunkCacheDbPath
    ? new EncryptedChunkCacheStore({
        path: opts.chunkCacheDbPath,
        key: opts.mappingKey,
        ttlSeconds: opts.chunkCacheTtlSeconds ?? 7 * 24 * 60 * 60,
      })
    : undefined;
  const chunkCache = new ChunkClassifierCache({ store: chunkCacheStore });

  return {
    async anonymize(req: AnonymizeRequest): Promise<AnonymizeResponse> {
      const tenantId = req.tenantId ?? rules.tenant;
      const ts = new Date().toISOString();
      const promptHash = hashPrompt(req.text);

      let llmFindings: Finding[] = [];
      try {
        // Chunked + gecacht: der Volltext wird an sicheren Grenzen (Absatz/
        // Zeile/Satz) in kleine Chunks geschnitten, jeder Chunk einzeln
        // klassifiziert (klein genug, um den Timeout zu schlagen) und das
        // Ergebnis je Chunk-Hash gecacht. Findings werden gemerged + nach
        // (type, value) dedupliziert. Ein ClassifierUnavailableError aus einem
        // beliebigen Chunk propagiert hier hoch -> fail-closed bleibt erhalten.
        const segmented = joinSegments(req);
        if (segmented.text.length > 0) {
          const found = await classifyEntitiesChunked(
            segmented.text,
            (chunk, signal) => classifyEntities(chunk, opts.classifier, signal),
            chunkCache,
            req.signal,
          );
          llmFindings = segmented.toFullText(found);
        }
      } catch (err) {
        if (err instanceof ClassifierUnavailableError) {
          const blocked: AnonymizeBlocked = { blocked: true, reason: "classifier_unavailable" };
          audit.write({
            ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
            promptHash, findings: {}, blocked: true, blockedReason: "classifier_unavailable",
          });
          return blocked;
        }
        throw err;
      }

      if (rules.block.art_9_categories) {
        const blockRank = CONF_RANK[rules.confidenceThreshold.block];
        const art9Hit = llmFindings.find(
          (f) => f.type === "ART_9" && CONF_RANK[f.confidence] >= blockRank,
        );
        if (art9Hit) {
          const blocked: AnonymizeBlocked = { blocked: true, reason: "art_9_data_detected" };
          audit.write({
            ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
            promptHash, findings: { ART_9: 1 }, blocked: true, blockedReason: "art_9_data_detected",
          });
          return blocked;
        }
      }

      const piiFindings = detectRegexFindings(req, rules.detect.pii as DetectorKey[]);

      // Regex-Treffer werden immer anonymisiert (deterministisch, definitorisch sensibel).
      // Confidence-Schwelle gilt nur für LLM-Findings.
      const anonRank = CONF_RANK[rules.confidenceThreshold.anonymize];
      const filtered = [
        ...piiFindings,
        ...expandClassifierFindings(
          req,
          llmFindings.filter((f) => CONF_RANK[f.confidence] >= anonRank),
        ),
      ];

      const { text: anonText, mappings } = anonymizeText(req.text, withoutOverlaps(filtered));
      const mappingId = randomUUID();
      store.write(mappingId, tenantId, mappings, rules.mapping.ttlSeconds);

      const counts: Record<string, number> = {};
      const confByType: Record<string, Confidence> = {};
      for (const f of filtered) {
        counts[f.type] = (counts[f.type] ?? 0) + 1;
        const cur = confByType[f.type];
        if (!cur || CONF_RANK[f.confidence] > CONF_RANK[cur]) confByType[f.type] = f.confidence;
      }

      audit.write({
        ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
        promptHash, findings: counts, blocked: false,
      });

      const result: AnonymizeResult = {
        mappingId,
        anonymizedText: anonText,
        findings: Object.entries(counts).map(([type, count]) => ({
          type: type as AnonymizeResult["findings"][number]["type"],
          count,
          confidence: confByType[type],
        })),
        warnings: [],
      };
      return result;
    },

    deanonymize(req: DeanonymizeRequest): DeanonymizeResult {
      const mappings = store.read(req.mappingId);
      return { text: deanonymizeText(req.text, mappings) };
    },

    getMappingTable(mappingId: string): Map<string, string> {
      const entries = store.read(mappingId);
      const table = new Map<string, string>();
      for (const entry of entries) table.set(entry.pseudonym, entry.plaintext);
      return table;
    },

    close(): void {
      store.close();
      chunkCacheStore?.close();
    },
  };
}

export { safeExternalCall } from "./safe-external-call.js";
export type { SafeExternalCallOptions, SafeExternalCallResult } from "./safe-external-call.js";
export { MappingNotFoundError } from "./errors.js";
export { createPiiProxyClient, type PiiProxyClient, type PiiProxyClientOptions } from "./client.js";
export {
  extractSafePrefix,
  flushStreamRemainder,
  createStreamDeanonymizer,
  type ExtractSafePrefixOptions,
  type ExtractSafePrefixResult,
  type StreamDeanonymizer,
} from "./stream-deanonymizer.js";
