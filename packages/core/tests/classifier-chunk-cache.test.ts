import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Finding } from "../src/types.js";
import {
  splitIntoChunks,
  classifyEntitiesChunked,
  ChunkClassifierCache,
  MAX_CHUNK_CHARS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  type ChunkClassifier,
} from "../src/classifier-chunk-cache.js";

function person(value: string, confidence: Finding["confidence"] = "high"): Finding {
  return { type: "PERSON", value, start: 0, end: value.length, confidence, source: "llm" };
}

// Hilfs-Mock: zählt Aufrufe und liefert pro Chunk die übergebenen Findings,
// gefiltert auf solche, die tatsächlich (als Substring) im Chunk vorkommen —
// so wie der echte Klassifikator (value muss exakter Substring sein).
function makeCountingClassifier(
  byValue: Finding[],
): { fn: ChunkClassifier; calls: () => number; seen: () => string[] } {
  let calls = 0;
  const seen: string[] = [];
  const fn: ChunkClassifier = async (chunk: string) => {
    calls += 1;
    seen.push(chunk);
    return byValue
      .filter((f) => chunk.includes(f.value))
      .map((f) => {
        const start = chunk.indexOf(f.value);
        return { ...f, start, end: start + f.value.length };
      });
  };
  return { fn, calls: () => calls, seen: () => seen };
}

describe("splitIntoChunks", () => {
  it("exponiert benannte Konstanten mit erwarteten Defaults", () => {
    expect(MAX_CHUNK_CHARS).toBe(4000);
    expect(CACHE_TTL_MS).toBe(60 * 60 * 1000);
    expect(CACHE_MAX_ENTRIES).toBe(512);
  });

  it("teilt langen Mehr-Absatz-Text in mehrere Chunks", () => {
    const para = "Dies ist ein Absatz mit Inhalt. ".repeat(200); // ~6400 Zeichen
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // Verlustfrei: jeder Chunk ist Substring des Originals
    for (const c of chunks) expect(text.includes(c.trim()) || text.includes(c)).toBe(true);
  });

  it("teilt eine bekannte Entität NICHT mitten durch (Absatz-/Satzgrenzen)", () => {
    // Lange Absätze, dazwischen ein Name. Egal wie gesplittet wird, der Name
    // bleibt innerhalb eines Chunks (er steht nicht an einer Split-Grenze).
    const filler = "Lorem ipsum dolor sit amet. ".repeat(160); // ~4480 Zeichen
    const text = `${filler}\n\nDr. Anna Müller leitet die Abteilung.\n\n${filler}`;
    const chunks = splitIntoChunks(text);
    const intact = chunks.some((c) => c.includes("Dr. Anna Müller"));
    expect(intact).toBe(true);
  });

  it("kurzer Text bleibt ein einziger Chunk", () => {
    expect(splitIntoChunks("Dr. Anna Müller war da.")).toEqual(["Dr. Anna Müller war da."]);
  });
});

describe("classifyEntitiesChunked", () => {
  it("klassifiziert jeden Chunk genau einmal; gemeinsamer Prefix trifft den Cache bei Wiederholung", async () => {
    const staticPrefix = ("Statischer System-Kontext. ".repeat(200)).trimEnd(); // großer Block
    const dynamic1 = "Dr. Anna Müller hat angerufen.";
    const dynamic2 = "Herr Bernd Schulz schreibt.";

    const cache = new ChunkClassifierCache();
    const c1 = makeCountingClassifier([person("Dr. Anna Müller")]);

    const text1 = `${staticPrefix}\n\n${dynamic1}`;
    const f1 = await classifyEntitiesChunked(text1, c1.fn, cache);
    expect(f1.some((f) => f.value === "Dr. Anna Müller")).toBe(true);
    const firstCallCount = c1.calls();
    expect(firstCallCount).toBeGreaterThan(1); // mehrere Chunks

    // Zweiter Aufruf: identischer Prefix, anderer dynamischer Teil.
    const c2 = makeCountingClassifier([person("Bernd Schulz")]);
    const text2 = `${staticPrefix}\n\n${dynamic2}`;
    const f2 = await classifyEntitiesChunked(text2, c2.fn, cache);
    expect(f2.some((f) => f.value === "Bernd Schulz")).toBe(true);

    // Die statischen Prefix-Chunks kamen aus dem Cache; nur der NEUE
    // dynamische Chunk löst einen Klassifikator-Aufruf aus.
    expect(c2.calls()).toBe(1);
  });

  it("merged Findings aus mehreren Chunks und dedupliziert nach (type,value); value bleibt exakter Substring des Volltexts", async () => {
    const block = "Allgemeiner Text ohne PII. ".repeat(170); // > MAX_CHUNK_CHARS
    // Anna in Chunk 1, Bernd in einem späteren Chunk, Anna nochmal am Ende (Dup).
    const text = `Dr. Anna Müller. ${block}\n\nHerr Bernd Schulz. ${block}\n\nNochmal Dr. Anna Müller.`;
    const cache = new ChunkClassifierCache();
    const c = makeCountingClassifier([person("Dr. Anna Müller"), person("Bernd Schulz")]);

    const findings = await classifyEntitiesChunked(text, c.fn, cache);

    const persons = findings.filter((f) => f.type === "PERSON");
    expect(persons.map((f) => f.value).sort()).toEqual(["Bernd Schulz", "Dr. Anna Müller"]);
    // dedupe: Anna nur einmal trotz zweier Vorkommen
    expect(persons.filter((f) => f.value === "Dr. Anna Müller")).toHaveLength(1);
    // exakter Substring des Volltexts
    for (const f of findings) expect(text.includes(f.value)).toBe(true);
  });

  it("ART_9-Finding aus irgendeinem Chunk fließt unverändert durch (mit confidence)", async () => {
    const block = "Neutraler Fülltext. ".repeat(230); // > MAX_CHUNK_CHARS
    const text = `${block}\n\nDer Patient ist HIV-positiv.\n\n${block}`;
    const art9: Finding = {
      type: "ART_9",
      value: "HIV-positiv",
      start: 0,
      end: "HIV-positiv".length,
      confidence: "high",
      source: "llm",
    };
    const cache = new ChunkClassifierCache();
    const c = makeCountingClassifier([art9]);
    const findings = await classifyEntitiesChunked(text, c.fn, cache);
    const hit = findings.find((f) => f.type === "ART_9");
    expect(hit).toBeDefined();
    expect(hit?.confidence).toBe("high");
    expect(hit?.value).toBe("HIV-positiv");
  });

  it("cached einen fehlgeschlagenen Chunk NICHT (GDPR-Invariante: Fehler propagiert, kein leerer Cache-Eintrag)", async () => {
    // Ein einziger, kurzer Text -> genau ein Chunk. Der Klassifikator wirft
    // beim ersten Aufruf. Erwartung: der Fehler wird durchgereicht (nicht
    // verschluckt) und der Chunk landet NICHT als (leerer) Eintrag im Cache —
    // sonst würde ein späterer Aufruf fälschlich "keine PII" zurückgeben und
    // damit fail-open auf nicht-klassifizierte Daten.
    const text = "Dr. Anna Müller hat angerufen.";
    const cache = new ChunkClassifierCache();
    const hash = createHash("sha256").update(text, "utf8").digest("hex");

    let calls = 0;
    const throwing: ChunkClassifier = async (chunk: string) => {
      calls += 1;
      throw new Error(`classifier unavailable for chunk: ${chunk.slice(0, 8)}`);
    };

    // (1) Fehler wird propagiert, nicht geschluckt.
    await expect(classifyEntitiesChunked(text, throwing, cache)).rejects.toThrow(
      /classifier unavailable/,
    );
    expect(calls).toBe(1);

    // (2) Kein Cache-Eintrag für den fehlgeschlagenen Chunk-Hash.
    expect(cache.get(hash)).toBeUndefined();
    expect(cache.size()).toBe(0);

    // (3) Folgeaufruf ruft den Klassifikator ERNEUT auf (kein gecachtes
    // leeres Ergebnis) — hier mit einem funktionierenden Klassifikator.
    const ok = makeCountingClassifier([person("Dr. Anna Müller")]);
    const findings = await classifyEntitiesChunked(text, ok.fn, cache);
    expect(ok.calls()).toBe(1);
    expect(findings.some((f) => f.value === "Dr. Anna Müller")).toBe(true);
  });
});

describe("ChunkClassifierCache — L2 Backing-Store", () => {
  // Einfacher, deterministischer Fake-Store (Map) mit get/set wie der echte
  // persistente Store. Geteilt über zwei ChunkClassifierCache-Instanzen =
  // Simulation eines Proxy-Neustarts (frische In-Memory-L1, gleiche L2).
  function makeFakeStore() {
    const m = new Map<string, Finding[]>();
    let sets = 0;
    return {
      get: (h: string) => m.get(h),
      set: (h: string, f: Finding[]) => {
        sets += 1;
        m.set(h, f);
      },
      sets: () => sets,
      size: () => m.size,
    };
  }

  it("schreibt Findings write-through in die L2", async () => {
    const store = makeFakeStore();
    const cache = new ChunkClassifierCache({ store });
    const c = makeCountingClassifier([person("Dr. Anna Müller")]);
    await classifyEntitiesChunked("Dr. Anna Müller war da.", c.fn, cache);
    expect(store.size()).toBe(1);
    expect(store.sets()).toBe(1);
  });

  it("nach 'Neustart' (frische L1, gleiche L2): 0 Klassifikator-Aufrufe, Findings aus L2", async () => {
    const store = makeFakeStore();
    const text = "Dr. Anna Müller hat angerufen.";

    const c1 = makeCountingClassifier([person("Dr. Anna Müller")]);
    await classifyEntitiesChunked(text, c1.fn, new ChunkClassifierCache({ store }));
    expect(c1.calls()).toBe(1);

    const c2 = makeCountingClassifier([person("Dr. Anna Müller")]);
    const findings = await classifyEntitiesChunked(text, c2.fn, new ChunkClassifierCache({ store }));
    expect(c2.calls()).toBe(0); // komplett aus L2 bedient
    expect(findings.some((f) => f.value === "Dr. Anna Müller")).toBe(true);
  });

  it("ohne Store verhält sich der Cache unverändert (reine L1)", async () => {
    const cache = new ChunkClassifierCache();
    const c = makeCountingClassifier([person("Dr. Anna Müller")]);
    await classifyEntitiesChunked("Dr. Anna Müller war da.", c.fn, cache);
    expect(c.calls()).toBe(1);
  });
});

describe("ChunkClassifierCache TTL + LRU", () => {
  it("verfällt Einträge nach TTL (injizierbare Uhr)", async () => {
    let now = 1_000_000;
    const cache = new ChunkClassifierCache({ ttlMs: 1000, clock: () => now });
    const text = "Dr. Anna Müller war da.";
    const c1 = makeCountingClassifier([person("Dr. Anna Müller")]);

    await classifyEntitiesChunked(text, c1.fn, cache);
    expect(c1.calls()).toBe(1);

    // innerhalb TTL: Cache-Hit, kein neuer Aufruf
    now += 500;
    const c2 = makeCountingClassifier([person("Dr. Anna Müller")]);
    await classifyEntitiesChunked(text, c2.fn, cache);
    expect(c2.calls()).toBe(0);

    // nach TTL: Miss, neuer Aufruf
    now += 1000;
    const c3 = makeCountingClassifier([person("Dr. Anna Müller")]);
    await classifyEntitiesChunked(text, c3.fn, cache);
    expect(c3.calls()).toBe(1);
  });

  it("evicted bei Überschreiten der Max-Größe (LRU-artig)", async () => {
    const cache = new ChunkClassifierCache({ maxEntries: 2, clock: () => 0 });
    const mk = (s: string) => makeCountingClassifier([]).fn;

    // 3 verschiedene Chunks -> bei maxEntries=2 fällt der älteste raus.
    await classifyEntitiesChunked("AAA erster chunk.", mk("a"), cache);
    await classifyEntitiesChunked("BBB zweiter chunk.", mk("b"), cache);
    await classifyEntitiesChunked("CCC dritter chunk.", mk("c"), cache);
    expect(cache.size()).toBeLessThanOrEqual(2);

    // Der zuerst eingefügte ("AAA...") sollte evicted sein -> erneuter Miss.
    const again = makeCountingClassifier([]);
    await classifyEntitiesChunked("AAA erster chunk.", again.fn, cache);
    expect(again.calls()).toBe(1);
  });
});

// --- Positionsstabilität der Chunk-Grenzen ---
//
// Agenten-Prompts wachsen zwischen zwei Turns nur an wenigen Stellen, aber der
// Klassifikator-Cache greift nur bei exakt gleichem Chunk-Text. Werden die
// Grenzen greedy von vorne gepackt, verschiebt schon eine kurze Einfügung am
// Anfang (Claude Code hängt pro Request u.a. einen frischen Zeitstempel an)
// ALLE folgenden Grenzen — jeder Chunk bekommt einen neuen Hash und der
// komplette Prompt wird neu klassifiziert. Am laufenden Proxy gemessen:
// identischer Text 0,0 s, derselbe Text mit 22 geänderten Zeichen am Anfang
// wieder volle 35,4 s. Die Grenzen müssen sich deshalb nach einer Einfügung
// wieder auf den unveränderten Text einsynchronisieren.
describe("splitIntoChunks Positionsstabilität", () => {
  function corpus(paragraphs: number): string {
    const out: string[] = [];
    for (let i = 0; i < paragraphs; i++) {
      // Bewusst unterschiedlich lange Absätze — gleichmäßige Absätze würden
      // sich auch beim greedy Packen zufällig wieder einsynchronisieren.
      const words = 12 + ((i * 7) % 40);
      out.push(`Absatz ${i}: ` + `Wort${i} `.repeat(words).trim() + ".");
    }
    return out.join("\n\n");
  }

  it("behält nach einer Einfügung am Anfang die meisten Chunk-Grenzen bei", () => {
    const text = corpus(300);
    const before = splitIntoChunks(text);
    const after = splitIntoChunks("Aktuelle Uhrzeit: 18:35:07.\n\n" + text);

    const afterSet = new Set(after);
    const survivors = before.filter((c) => afterSet.has(c)).length;
    const ratio = survivors / before.length;

    expect(before.length).toBeGreaterThan(10);
    expect(ratio).toBeGreaterThan(0.8);
  });

  it("schneidet weiterhin nur Chunks bis maxChars", () => {
    for (const chunk of splitIntoChunks(corpus(300))) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it("bleibt verlustfrei — die Chunks ergeben zusammengesetzt den Originaltext", () => {
    const text = corpus(300);
    expect(splitIntoChunks(text).join("")).toBe(text);
  });
});

// --- Abort-Propagation (verwaiste Klassifikationen vermeiden) ---
//
// Schließt der Client die Verbindung (Claude-CLI bricht nach 600 s ab), läuft
// die Chunk-Klassifikation im Proxy sonst weiter. Retry 2 startet dann eine
// ZWEITE parallele Klassifikation desselben Prompts, Retry 10 die zehnte —
// alle teilen sich eine GPU und verhindern die Konvergenz. So kippte der Proxy
// am 2026-07-24 (119 verwaiste Requests). Ein durchgereichtes AbortSignal muss
// die Chunk-Schleife stoppen, sobald der Client weg ist.
describe("classifyEntitiesChunked Abort-Propagation", () => {
  function corpus(paragraphs: number): string {
    const out: string[] = [];
    for (let i = 0; i < paragraphs; i++) {
      out.push(`Absatz ${i}: ` + `Wort${i} `.repeat(400).trim() + ".");
    }
    return out.join("\n\n");
  }

  it("klassifiziert keinen einzigen Chunk, wenn das Signal schon abgebrochen ist", async () => {
    const cache = new ChunkClassifierCache({});
    const clf = makeCountingClassifier([]);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      classifyEntitiesChunked(corpus(10), clf.fn, cache, ctrl.signal),
    ).rejects.toThrow();
    expect(clf.calls()).toBe(0);
  });

  it("stoppt die Schleife mitten drin, sobald das Signal abbricht", async () => {
    const cache = new ChunkClassifierCache({});
    const ctrl = new AbortController();
    let calls = 0;
    // Klassifikator bricht die Verbindung nach dem 2. Chunk ab — modelliert den
    // Client-Disconnect während der Verarbeitung.
    const fn: ChunkClassifier = async () => {
      calls += 1;
      if (calls === 2) ctrl.abort();
      return [];
    };

    await expect(
      classifyEntitiesChunked(corpus(20), fn, cache, ctrl.signal),
    ).rejects.toThrow();
    // Nach dem Abbruch dürfen die restlichen ~18 Chunks nicht mehr laufen.
    expect(calls).toBeLessThan(20);
  });

  it("läuft normal durch, wenn kein Signal übergeben wird", async () => {
    const cache = new ChunkClassifierCache({});
    const clf = makeCountingClassifier([]);
    const chunks = splitIntoChunks(corpus(20)).length;
    await classifyEntitiesChunked(corpus(20), clf.fn, cache);
    expect(clf.calls()).toBe(chunks);
  });
});
