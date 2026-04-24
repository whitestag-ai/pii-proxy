import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerAnthropicPassthroughRoute } from "../../src/routes/anthropic-passthrough.js";
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
