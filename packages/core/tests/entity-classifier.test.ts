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

  // --- Part 3: Retry bei transienten Fehlern (geteiltes Modell unter Last) ---

  function okFindingsResponse(): Response {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({
          findings: [{ type: "PERSON", value: "Anna Müller", confidence: "high" }],
        }) } }],
      }),
      { status: 200 },
    );
  }

  it("wiederholt bei transientem fetch-Fehler und liefert beim Folgeversuch Findings", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(okFindingsResponse());
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234", model: "qwen3.6", timeoutMs: 100,
      retries: 2, retryBackoffMs: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "PERSON", value: "Anna Müller" });
  });

  it("wiederholt bei HTTP 5xx, aber nicht bei 4xx", async () => {
    const fiveHundred = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(okFindingsResponse());
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234", model: "x", timeoutMs: 100, retries: 1, retryBackoffMs: 0,
    });
    expect(fiveHundred).toHaveBeenCalledTimes(2);
    expect(findings).toHaveLength(1);

    vi.restoreAllMocks();
    const fourHundred = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100, retries: 3, retryBackoffMs: 0 }),
    ).rejects.toThrow("classifier_unavailable");
    expect(fourHundred).toHaveBeenCalledTimes(1); // 4xx = nicht retrybar
  });

  it("gibt nach erschöpften Retries fail-closed auf", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100, retries: 2, retryBackoffMs: 0 }),
    ).rejects.toThrow("classifier_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 Versuch + 2 Retries
  });

  // --- Part 4: Fallback-Modell (Nacht / RTX-Classifier-Ausfall) ---

  // Routet fetch anhand des `model` im Request-Body: pro Modell entweder eine
  // Response oder ein Error (throw). Erfasst die aufgerufenen Modelle in Reihenfolge.
  function routeByModel(
    routes: Record<string, () => Response | Error>,
  ): { calls: () => string[] } {
    const calls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const model = JSON.parse(String((init as RequestInit).body)).model as string;
      calls.push(model);
      const r = routes[model];
      if (!r) throw new Error(`unerwartetes Modell: ${model}`);
      const out = r();
      if (out instanceof Error) throw out;
      return out;
    });
    return { calls: () => calls };
  }

  it("fällt bei nicht erreichbarem Primärmodell auf fallbackModel zurück", async () => {
    const t = routeByModel({
      "rtx-qat": () => new Error("network down"), // RTX nachts aus
      "studio-gemma": () => okFindingsResponse(),
    });
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234",
      model: "rtx-qat",
      fallbackModel: "studio-gemma",
      timeoutMs: 100,
      retries: 0,
      retryBackoffMs: 0,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "PERSON", value: "Anna Müller" });
    expect(t.calls()).toEqual(["rtx-qat", "studio-gemma"]);
  });

  it("fällt auch bei 4xx (Modell nicht geladen) auf fallback zurück", async () => {
    const t = routeByModel({
      "rtx-qat": () => new Response("model not found", { status: 404 }),
      "studio-gemma": () => okFindingsResponse(),
    });
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234",
      model: "rtx-qat",
      fallbackModel: "studio-gemma",
      timeoutMs: 100,
      retries: 0,
      retryBackoffMs: 0,
    });
    expect(findings).toHaveLength(1);
    expect(t.calls()).toEqual(["rtx-qat", "studio-gemma"]);
  });

  it("nutzt den Fallback NICHT wenn das Primärmodell erfolgreich ist", async () => {
    const t = routeByModel({
      "rtx-qat": () => okFindingsResponse(),
      "studio-gemma": () => new Error("darf nicht aufgerufen werden"),
    });
    const findings = await classifyEntities("Anna Müller war da", {
      url: "http://localhost:1234",
      model: "rtx-qat",
      fallbackModel: "studio-gemma",
      timeoutMs: 100,
      retries: 0,
      retryBackoffMs: 0,
    });
    expect(findings).toHaveLength(1);
    expect(t.calls()).toEqual(["rtx-qat"]); // Fallback nie berührt
  });

  it("ohne fallbackModel wirft der Primärfehler unverändert (kein Fallback)", async () => {
    const t = routeByModel({ "rtx-qat": () => new Error("down") });
    await expect(
      classifyEntities("text", {
        url: "http://localhost:1234",
        model: "rtx-qat",
        timeoutMs: 100,
        retries: 0,
        retryBackoffMs: 0,
      }),
    ).rejects.toThrow("classifier_unavailable");
    expect(t.calls()).toEqual(["rtx-qat"]);
  });
});
