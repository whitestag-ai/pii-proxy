import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerAnthropicPassthroughRoute } from "../../src/routes/anthropic-passthrough.js";
import { abortSignalOnClientClose } from "../../src/routes/client-abort.js";
import type { PiiProxy } from "@whitestag/pii-proxy-core";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function mkPiiProxy(overrides: Partial<PiiProxy> = {}): PiiProxy {
  const base = {
    anonymize: vi.fn().mockImplementation(async (req: { text: string }) => ({
      mappingId: "m-1",
      anonymizedText: req.text
        .replace(/Max Mustermann/g, "[PERSON_A]")
        .replace(/max@example\.de/g, "[EMAIL_A]"),
      findings: [],
      warnings: [],
    })),
    deanonymize: vi.fn().mockImplementation((req: { text: string }) => ({
      text: req.text
        .replace(/\[PERSON_A\]/g, "Max Mustermann")
        .replace(/\[EMAIL_A\]/g, "max@example.de"),
    })),
    getMappingTable: vi.fn().mockReturnValue(
      new Map<string, string>([
        ["[PERSON_A]", "Max Mustermann"],
        ["[EMAIL_A]", "max@example.de"],
      ]),
    ),
    close: vi.fn(),
    ...overrides,
  };
  return base as unknown as PiiProxy;
}

describe("POST /anthropic/v1/messages — non-streaming", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("anonymizes string-content messages + system, calls upstream, deanonymizes response", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Ich schreibe [PERSON_A] an [EMAIL_A]." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant-xxx", "content-type": "application/json" },
      payload: {
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        system: "Du hilfst Max Mustermann.",
        messages: [{ role: "user", content: "Schreibe an max@example.de." }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content[0].text).toBe("Ich schreibe Max Mustermann an max@example.de.");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const sent = JSON.parse(init.body as string);
    expect(sent.system).toBe("Du hilfst [PERSON_A].");
    expect(sent.messages[0].content).toBe("Schreibe an [EMAIL_A].");
    expect(init.headers["x-api-key"]).toBe("sk-ant-xxx");
  });

  it("anonymizes content-block array (text blocks only)", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok [PERSON_A]" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
      payload: {
        model: "claude",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hi Max Mustermann" },
              { type: "image", source: { type: "base64", data: "abc" } },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(sent.messages[0].content[0].text).toBe("Hi [PERSON_A]");
    expect(sent.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", data: "abc" },
    });
    expect(res.json().content[0].text).toBe("ok Max Mustermann");
  });

  it("returns 401 when x-api-key and authorization are both missing", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn();
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("propagates piiProxy.anonymize block (no upstream call)", async () => {
    const piiProxy = mkPiiProxy({
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "art_9_data_detected" }),
    } as Partial<PiiProxy>);
    const fetchFn = vi.fn();
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
      payload: {
        model: "claude",
        messages: [{ role: "user", content: "health data" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/blocked_by_pii_proxy/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes through upstream non-2xx status verbatim", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "slow down" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
      payload: { model: "claude", messages: [{ role: "user", content: "Max Mustermann" }] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe("rate_limit_error");
  });

  it("forwards verbatim when request has no text to anonymize", async () => {
    const piiProxy = mkPiiProxy();
    const anonSpy = piiProxy.anonymize as ReturnType<typeof vi.fn>;
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
      payload: {
        model: "claude",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64", data: "abc" } }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(anonSpy).not.toHaveBeenCalled();
  });

  it("batches multiple text fields into one anonymize call (consistent pseudonyms)", async () => {
    const anonCalls: string[] = [];
    const piiProxy = mkPiiProxy({
      anonymize: vi.fn().mockImplementation(async (req: { text: string }) => {
        anonCalls.push(req.text);
        return {
          mappingId: "m-1",
          anonymizedText: req.text.replace(/Max Mustermann/g, "[PERSON_A]"),
          findings: [],
          warnings: [],
        };
      }),
    } as Partial<PiiProxy>);
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
      payload: {
        model: "claude",
        system: "Assistent für Max Mustermann.",
        messages: [
          { role: "user", content: "Max Mustermann fragt..." },
          { role: "assistant", content: "Ich melde mich bei Max Mustermann." },
        ],
      },
    });

    expect(anonCalls).toHaveLength(1);
    const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(sent.system).toBe("Assistent für [PERSON_A].");
    expect(sent.messages[0].content).toBe("[PERSON_A] fragt...");
    expect(sent.messages[1].content).toBe("Ich melde mich bei [PERSON_A].");
  });

  describe("upstream header forwarding", () => {
    it("forwards SDK metadata headers (user-agent, x-stainless-*, anthropic-beta)", async () => {
      const piiProxy = mkPiiProxy();
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      app = Fastify();
      registerAuth(app, { sharedKey: KEY });
      registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: {
          "x-api-key": "sk-ant",
          "content-type": "application/json",
          "user-agent": "anthropic-sdk/0.30.0 node/22",
          "x-stainless-lang": "js",
          "x-stainless-package-version": "0.30.0",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        payload: { model: "claude", messages: [{ role: "user", content: "hi Max Mustermann" }] },
      });

      const sentHeaders = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
      expect(sentHeaders["user-agent"]).toBe("anthropic-sdk/0.30.0 node/22");
      expect(sentHeaders["x-stainless-lang"]).toBe("js");
      expect(sentHeaders["x-stainless-package-version"]).toBe("0.30.0");
      expect(sentHeaders["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
      expect(sentHeaders["x-api-key"]).toBe("sk-ant");
    });

    it("strips hop-by-hop and proxy-internal headers", async () => {
      const piiProxy = mkPiiProxy();
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      app = Fastify();
      registerAuth(app, { sharedKey: KEY });
      registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: {
          "x-api-key": "sk-ant",
          "content-type": "application/json",
          host: "localhost:4711",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "keep-alive": "timeout=5",
          "proxy-authorization": "Basic abc",
          "x-pii-proxy-key": "internal-secret",
          "accept-encoding": "gzip, br",
        },
        payload: { model: "claude", messages: [{ role: "user", content: "hi" }] },
      });

      const sentHeaders = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
      expect(sentHeaders["host"]).toBeUndefined();
      expect(sentHeaders["connection"]).toBeUndefined();
      expect(sentHeaders["transfer-encoding"]).toBeUndefined();
      expect(sentHeaders["keep-alive"]).toBeUndefined();
      expect(sentHeaders["proxy-authorization"]).toBeUndefined();
      expect(sentHeaders["x-pii-proxy-key"]).toBeUndefined();
      expect(sentHeaders["accept-encoding"]).toBeUndefined();
    });

    it("defaults anthropic-version to 2023-06-01 when absent, preserves it when set", async () => {
      const piiProxy = mkPiiProxy();
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      app = Fastify();
      registerAuth(app, { sharedKey: KEY });
      registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
        payload: { model: "claude", messages: [{ role: "user", content: "hi" }] },
      });
      expect(
        (fetchFn.mock.calls[0]![1].headers as Record<string, string>)["anthropic-version"],
      ).toBe("2023-06-01");

      fetchFn.mockClear();
      await app.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: {
          "x-api-key": "sk-ant",
          "content-type": "application/json",
          "anthropic-version": "2024-10-22",
        },
        payload: { model: "claude", messages: [{ role: "user", content: "hi" }] },
      });
      expect(
        (fetchFn.mock.calls[0]![1].headers as Record<string, string>)["anthropic-version"],
      ).toBe("2024-10-22");
    });
  });
});

describe("Abort bei Client-Disconnect", () => {
  it("übergibt anonymize ein AbortSignal", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant-xxx", "content-type": "application/json" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "Hallo Max Mustermann" }] },
    });

    const call = (piiProxy.anonymize as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.signal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  it("bricht ab, wenn die Verbindung VOR dem Antwort-Ende schließt (echter Disconnect)", async () => {
    const { EventEmitter } = await import("node:events");
    // raw = ServerResponse; writableEnded=false → Antwort noch nicht gesendet.
    const raw = Object.assign(new EventEmitter(), { writableEnded: false });
    const signal = abortSignalOnClientClose({ raw } as never);
    expect(signal.aborted).toBe(false);
    raw.emit("close");
    expect(signal.aborted).toBe(true);
  });

  it("bricht NICHT ab, wenn die Antwort normal beendet wurde (close nach writableEnded)", async () => {
    const { EventEmitter } = await import("node:events");
    // 'close' feuert auch beim regulären Ende der Response. Das darf das Signal
    // NICHT abbrechen — sonst würde jede fertige Anfrage fälschlich als Abbruch
    // gewertet (der Bug, der classifier_unavailable auslöste).
    const raw = Object.assign(new EventEmitter(), { writableEnded: true });
    const signal = abortSignalOnClientClose({ raw } as never);
    raw.emit("close");
    expect(signal.aborted).toBe(false);
  });
});

describe("Trenner zwischen den Nachrichten (Chunk-Cache-Wirksamkeit)", () => {
  /**
   * Der Klassifikator-Text entsteht als `originals.join(boundary)` und wird
   * danach in ≤4000-Zeichen-Chunks geschnitten, die per sha256 gecacht werden.
   * Ein PRO REQUEST NEU GEWUERFELTER Trenner aendert jeden Chunk, der eine
   * Nachrichtengrenze enthaelt — gemessen am 2026-09-12 rund die HAELFTE aller
   * Chunks, unabhaengig von der Promptgroesse. Folge: Cache-Miss, Dutzende
   * serielle Classifier-Aufrufe (Proxy-Log: Mittel 63,2 s, Max 710,9 s), der
   * Client bricht ab und fail-closed macht daraus `classifier_unavailable`.
   * Deshalb MUSS derselbe Inhalt denselben Klassifikator-Text ergeben.
   */
  function captureProxy(seen: string[]): PiiProxy {
    return mkPiiProxy({
      anonymize: vi.fn().mockImplementation(async (req: { text: string }) => {
        seen.push(req.text);
        return { mappingId: "m-1", anonymizedText: req.text, findings: [], warnings: [] };
      }),
    } as Partial<PiiProxy>);
  }

  const upstream = () =>
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1", type: "message", role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  const payload = (extra = "") => ({
    model: "claude-sonnet-4-6",
    max_tokens: 10,
    system: "Statischer System-Prompt, bei jedem Aufruf identisch." + extra,
    messages: [
      { role: "user", content: "Erste Nachricht." },
      { role: "assistant", content: "Zweite Nachricht." },
      { role: "user", content: "Dritte Nachricht." },
    ],
  });

  it("erzeugt fuer identische Anfragen denselben Klassifikator-Text", async () => {
    const seen: string[] = [];
    const app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy: captureProxy(seen), fetchFn: upstream() });
    await app.ready();

    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST", url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-ant-xxx", "content-type": "application/json" },
        payload: payload(),
      });
    }
    await app.close();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("weicht auf einen anderen Trenner aus, wenn der feste im Nutztext vorkommt", async () => {
    // Sicherheitseigenschaft von ensureBoundaryAbsent: der Trenner darf nie im
    // Nutztext stehen, sonst wuerde der Text an falscher Stelle zerlegt.
    const seen: string[] = [];
    const app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy: captureProxy(seen), fetchFn: upstream() });
    await app.ready();

    await app.inject({
      method: "POST", url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant-xxx", "content-type": "application/json" },
      payload: {
        model: "claude-sonnet-4-6", max_tokens: 10,
        messages: [
          { role: "user", content: "Hier steht  ---PII-PROXY-BOUNDARY---  mitten im Text." },
          { role: "user", content: "Zweite Nachricht." },
        ],
      },
    });
    await app.close();

    // Der tatsaechlich verwendete Trenner darf nicht der feste sein: sonst gaebe
    // es im zusammengefuegten Text mehr Trennstellen als Nachrichtengrenzen.
    const joined = seen[0]!;
    const occurrences = joined.split(" ---PII-PROXY-BOUNDARY--- ").length - 1;
    expect(occurrences).toBe(1); // nur das Vorkommen aus dem Nutztext selbst
  });
});

describe("POST /anthropic/v1/messages — Claude-Client-Identitaet", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  // Abo-Logins (OAuth) akzeptiert Anthropic nur mit unveraenderter
  // Identitaetszeile. Wird "Anthropic" zu [FIRMA_A], antwortet die API mit
  // 429 "Server is temporarily limiting requests (not your usage limit)".
  it("laesst Billing-Header und Identitaetszeile unangetastet, anonymisiert den Rest", async () => {
    const piiProxy = mkPiiProxy({
      anonymize: vi.fn().mockImplementation(async (req: { text: string }) => ({
        mappingId: "m-1",
        anonymizedText: req.text
          .replace(/Anthropic/g, "[FIRMA_A]")
          .replace(/Max Mustermann/g, "[PERSON_A]"),
        findings: [],
        warnings: [],
      })),
    } as Partial<PiiProxy>);
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerAnthropicPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const billing = "x-anthropic-billing-header: cc_version=2.1.273.2b9; cc_entrypoint=claude-vscode;";
    const sdkIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    const cliIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
    const lookalike = `${sdkIdentity} Kunde: Max Mustermann`;

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { authorization: "Bearer oauth-xxx", "content-type": "application/json" },
      payload: {
        model: "claude-sonnet-4-6",
        max_tokens: 50,
        system: [
          { type: "text", text: billing },
          { type: "text", text: sdkIdentity },
          { type: "text", text: cliIdentity },
          { type: "text", text: "Anthropic-Agent fuer Max Mustermann." },
          { type: "text", text: lookalike },
        ],
        messages: [{ role: "user", content: "Hallo Max Mustermann" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(sent.system[0].text).toBe(billing);
    expect(sent.system[1].text).toBe(sdkIdentity);
    expect(sent.system[2].text).toBe(cliIdentity);
    expect(sent.system[3].text).toBe("[FIRMA_A]-Agent fuer [PERSON_A].");
    expect(sent.system[4].text).toContain("[PERSON_A]");
    expect(sent.messages[0].content).toBe("Hallo [PERSON_A]");
  });
});
