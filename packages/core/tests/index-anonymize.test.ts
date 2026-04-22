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
