import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPiiProxy } from "../src/index.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pii-proxy-api-")); vi.restoreAllMocks(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function mockClassifier(findings: Array<{ type: string; value: string; confidence: string }>) {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings }) } }],
      }),
      { status: 200 },
    ),
  );
}

describe("createPiiProxy().anonymize", () => {
  it("anonymisiert PII + LLM-Findings, schreibt Mapping-Store + Audit-Log", async () => {
    mockClassifier([{ type: "PERSON", value: "Max Mustermann", confidence: "high" }]);
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const result = await proxy.anonymize({
      text: "Max Mustermann schreibt von max@whitestag.de",
      targetLlm: "claude",
      agent: "ceo",
    });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).not.toContain("Max Mustermann");
    expect(result.anonymizedText).not.toContain("max@whitestag.de");
    expect(result.mappingId).toMatch(/^[0-9a-f-]{36}$/);
    proxy.close();
  });

  it("blockiert bei ART_9 mit confidence high", async () => {
    mockClassifier([
      { type: "ART_9", value: "HIV-positiv", confidence: "high" },
    ]);
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const result = await proxy.anonymize({
      text: "Patient ist HIV-positiv",
      targetLlm: "claude",
      agent: "ceo",
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.reason).toBe("art_9_data_detected");
    proxy.close();
  });

  it("anonymisiert regex-Treffer auch wenn confidence threshold strenger ist", async () => {
    mockClassifier([]); // keine LLM-Findings
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
      rules: {
        tenant: "test",
        detect: { pii: ["steuernummer"], llm: [] },
        block: { art_9_categories: false },
        confidenceThreshold: { block: "high", anonymize: "high" },
        mapping: { ttlSeconds: 60 },
      },
    });
    // 11-stellige Steuer-IdNr emittiert confidence=medium aus dem Regex-Detektor
    const result = await proxy.anonymize({
      text: "Ident 12345678901 vermerken",
      targetLlm: "claude",
      agent: "ceo",
    });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).not.toContain("12345678901");
    proxy.close();
  });

  it("respektiert rules.detect.pii allow-list — disabled detectors triggern nicht", async () => {
    mockClassifier([]);
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
      rules: {
        tenant: "test",
        detect: { pii: ["email"], llm: [] }, // nur email, KEIN url
        block: { art_9_categories: false },
        confidenceThreshold: { block: "high", anonymize: "medium" },
        mapping: { ttlSeconds: 60 },
      },
    });
    const result = await proxy.anonymize({
      text: "Siehe https://whitestag.de und max@whitestag.de",
      targetLlm: "claude",
      agent: "ceo",
    });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).not.toContain("max@whitestag.de"); // email anonymisiert
    expect(result.anonymizedText).toContain("https://whitestag.de"); // url NICHT anonymisiert
    proxy.close();
  });

  it("chunked: anonymisiert PERSON aus einem späten Chunk eines langen Mehr-Absatz-Prompts", async () => {
    // Klassifikator antwortet pro Chunk: liefert die Person nur, wenn ihr
    // Wortlaut im jeweils gesendeten Chunk (user-message) vorkommt — wie das
    // echte Modell (value muss exakter Substring sein).
    const target = "Dr. Anna Müller";
    let calls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      calls += 1;
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userChunk = body.messages.find((m) => m.role === "user")?.content ?? "";
      const findings = userChunk.includes(target)
        ? [{ type: "PERSON", value: target, confidence: "high" }]
        : [];
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ findings }) } }] }),
        { status: 200 },
      );
    });

    const filler = "Allgemeiner statischer Kontext ohne PII. ".repeat(150); // > MAX_CHUNK_CHARS
    const text = `${filler}\n\n${target} ruft an.\n\n${filler}`;

    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const result = await proxy.anonymize({ text, targetLlm: "claude", agent: "ceo" });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).not.toContain(target);
    // Beweist Chunking: der lange Prompt löst mehrere Klassifikator-Aufrufe aus.
    expect(calls).toBeGreaterThan(1);
    proxy.close();
  });

  it("chunked: ART_9 high in einem späten Chunk blockiert weiterhin", async () => {
    const art9 = "HIV-positiv";
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userChunk = body.messages.find((m) => m.role === "user")?.content ?? "";
      const findings = userChunk.includes(art9)
        ? [{ type: "ART_9", value: art9, confidence: "high" }]
        : [];
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ findings }) } }] }),
        { status: 200 },
      );
    });

    const filler = "Neutraler Fülltext ohne Gesundheitsbezug. ".repeat(150);
    const text = `${filler}\n\nDer Patient ist ${art9}.\n\n${filler}`;

    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const result = await proxy.anonymize({ text, targetLlm: "claude", agent: "ceo" });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.reason).toBe("art_9_data_detected");
    proxy.close();
  });

  it("antwortet mit blocked: classifier_unavailable wenn LM Studio offline", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const result = await proxy.anonymize({
      text: "irgendwas",
      targetLlm: "claude",
      agent: "ceo",
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.reason).toBe("classifier_unavailable");
    proxy.close();
  });
});

describe("createPiiProxy().anonymize Abort", () => {
  it("bricht ab und klassifiziert nicht, wenn das Signal schon abgebrochen ist", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }), { status: 200 }),
    );
    const proxy = createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      proxy.anonymize({ text: "Max Mustermann war hier", targetLlm: "claude", agent: "ceo", signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    proxy.close();
  });
});

describe("createPiiProxy().anonymize — classifierSegments", () => {
  const mk = () =>
    createPiiProxy({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
  const SEP = " ---T--- ";
  const part1 = "Max Mustermann schreibt";
  const part2 = "Ausgabe von erika@example.org, Nummer 0171-1234567, PASS=geheim-123, PLZ 03046";
  const part3 = "Max Mustermann antwortet an tom@example.org";
  const text = [part1, part2, part3].join(SEP);
  const segments = [
    { start: 0, end: part1.length },
    { start: text.length - part3.length, end: text.length },
  ];

  it("klassifiziert nur die Segmente und setzt Treffer an die richtige Stelle", async () => {
    mockClassifier([{ type: "PERSON", value: "Max Mustermann", confidence: "high" }]);
    const proxy = mk();
    const result = await proxy.anonymize({
      text,
      targetLlm: "c",
      agent: "a",
      classifierSegments: segments,
      classifierSeparator: SEP,
    });
    if ("blocked" in result) throw new Error("unexpected block");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const gesendet = fetchMock.mock.calls.map((c) => String(c[1]?.body)).join("");
    expect(gesendet).toContain("Max Mustermann schreibt");
    expect(gesendet).toContain("antwortet an");
    expect(gesendet).not.toContain("erika@example.org");
    expect(gesendet).not.toContain("geheim-123");

    const teile = result.anonymizedText.split(SEP);
    expect(teile).toHaveLength(3);
    expect(teile[0]).toBe("[PERSON_A] schreibt");
    expect(teile[1]).toContain("[EMAIL_A]");
    expect(teile[1]).toContain("[PHONE_A]");
    expect(teile[1]).toContain("PASS=[API_KEY_A]");
    expect(teile[1]).toContain("PLZ 03046");
    expect(teile[2]).toContain("[EMAIL_B]");
    proxy.close();
  });

  it("wendet in Segmenten alle Regeln an, ausserhalb nur die strengen Muster", async () => {
    mockClassifier([]);
    const proxy = mk();
    const s = "https://example.org/x";
    const result = await proxy.anonymize({
      text: `${s}${SEP}${s}`,
      targetLlm: "c",
      agent: "a",
      classifierSegments: [{ start: 0, end: s.length }],
      classifierSeparator: SEP,
    });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).toBe(`[URL_A]${SEP}${s}`);
    proxy.close();
  });

  it("ruft den Classifier ohne Segmente gar nicht auf", async () => {
    mockClassifier([]);
    const proxy = mk();
    const result = await proxy.anonymize({
      text: "x@example.org",
      targetLlm: "c",
      agent: "a",
      classifierSegments: [],
      classifierSeparator: SEP,
    });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).toBe("[EMAIL_A]");
    expect(global.fetch).not.toHaveBeenCalled();
    proxy.close();
  });

  it("blockiert nicht wegen eines Classifier-Ausfalls, wenn nur Werkzeugtext vorliegt", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    const proxy = mk();
    const result = await proxy.anonymize({
      text: "nur Werkzeugtext",
      targetLlm: "c",
      agent: "a",
      classifierSegments: [],
      classifierSeparator: SEP,
    });
    expect("blocked" in result).toBe(false);
    proxy.close();
  });

  it("behaelt bei ueberlappenden Treffern den Regex-Treffer und laesst den Text heil", async () => {
    mockClassifier([{ type: "GESCHAEFTSGEHEIMNIS", value: "geheim-123", confidence: "high" }]);
    const proxy = mk();
    const result = await proxy.anonymize({ text: "PASS=geheim-123 Rest", targetLlm: "c", agent: "a" });
    if ("blocked" in result) throw new Error("unexpected block");
    expect(result.anonymizedText).toBe("PASS=[API_KEY_A] Rest");
    proxy.close();
  });
});
