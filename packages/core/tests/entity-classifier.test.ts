import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyEntities } from "../src/entity-classifier.js";

describe("classifyEntities", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("parst Klassifikator-Antwort und liefert Findings", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  findings: [
                    { type: "PERSON", value: "Max Mustermann", confidence: "high" },
                    { type: "FIRMA", value: "WHITESTAG GmbH", confidence: "high" },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const findings = await classifyEntities("Max Mustermann von WHITESTAG GmbH", {
      url: "http://localhost:1234",
      model: "gemma-4-26b",
      timeoutMs: 10000,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      type: "PERSON",
      value: "Max Mustermann",
      source: "llm",
      confidence: "high",
    });
    expect(findings[0].start).toBe(0);
    expect(findings[0].end).toBe("Max Mustermann".length);
  });

  it("wirft DpoUnavailableError wenn LM Studio nicht erreichbar", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("fetch failed"));
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100 }),
    ).rejects.toThrow("classifier_unavailable");
  });

  it("wirft DpoUnavailableError bei ungültigem JSON in der Antwort", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "kein json" } }],
        }),
        { status: 200 },
      ),
    );
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100 }),
    ).rejects.toThrow("classifier_unavailable");
  });

  // --- Part 2: reasoning_content fallback (reasoning models like qwen3.6) ---

  function mockResponse(message: Record<string, unknown>): void {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }),
        { status: 200 },
      ),
    );
  }

  it("nutzt reasoning_content wenn content leer ist (valides JSON)", async () => {
    mockResponse({
      content: "",
      reasoning_content: JSON.stringify({
        findings: [{ type: "PERSON", value: "Anna Müller", confidence: "high" }],
      }),
    });
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234",
      model: "qwen3.6",
      timeoutMs: 10000,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "PERSON", value: "Anna Müller", source: "llm" });
  });

  it("extrahiert JSON aus reasoning_content das in Prosa/Thinking-Tags gewickelt ist", async () => {
    mockResponse({
      content: "   ",
      reasoning_content:
        "<think>Ich überlege... das sieht nach einer Person aus.</think>\n" +
        'Hier ist mein Ergebnis: {"findings": [{"type": "PERSON", "value": "Anna Müller", "confidence": "medium"}]} — fertig.',
    });
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234",
      model: "qwen3.6",
      timeoutMs: 10000,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "PERSON", value: "Anna Müller", confidence: "medium" });
  });

  it("wirft fail-closed wenn weder content noch reasoning_content parsebares JSON liefern", async () => {
    mockResponse({ content: "", reasoning_content: "nur prosa, kein json hier" });
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100 }),
    ).rejects.toThrow("classifier_unavailable");
  });
});
