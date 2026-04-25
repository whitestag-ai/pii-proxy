import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerOpenaiChatPassthroughRoute } from "../../src/routes/openai-chat-passthrough.js";
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

describe("POST /openai/v1/chat/completions — non-streaming", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("anonymises string-content messages, calls upstream, deanonymises response", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi [PERSON_A], reply via [EMAIL_A]." },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You assist Max Mustermann." },
          { role: "user", content: "Send a draft to max@example.de." },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toBe("Hi Max Mustermann, reply via max@example.de.");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.messages[0].content).toBe("You assist [PERSON_A].");
    expect(sent.messages[1].content).toBe("Send a draft to [EMAIL_A].");
    expect(init.headers["authorization"]).toBe("Bearer sk-fake");
  });

  it("anonymises content-part array (text parts only, image_url passes through)", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "ok [PERSON_A]" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hi Max Mustermann" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(sent.messages[0].content[0].text).toBe("Hi [PERSON_A]");
    expect(sent.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } });
    expect(res.json().choices[0].message.content).toBe("ok Max Mustermann");
  });

  it("returns 401 when authorization is missing", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn();
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
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
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "patient health record" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/blocked_by_pii_proxy/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes through upstream non-2xx status verbatim", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Max Mustermann" }] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe("rate_limit_exceeded");
  });

  it("forwards verbatim when message-only conversation has no anonymisable text", async () => {
    const piiProxy = mkPiiProxy();
    const anonSpy = piiProxy.anonymize as ReturnType<typeof vi.fn>;
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    // Tool-only continuation: assistant message with no content, just tool_calls.
    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "1", content: null },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(anonSpy).not.toHaveBeenCalled();
  });

  it("handles assistant message with content=null (tool-only) — no deanonymisation needed", async () => {
    const piiProxy = mkPiiProxy();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Find Max Mustermann" }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBeNull();
    expect(res.json().choices[0].message.tool_calls).toBeDefined();
  });

  describe("upstream header forwarding", () => {
    it("forwards SDK metadata headers (user-agent, x-stainless-*, openai-organization)", async () => {
      const piiProxy = mkPiiProxy();
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      app = Fastify();
      registerAuth(app, { sharedKey: KEY });
      registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: {
          authorization: "Bearer sk-fake",
          "content-type": "application/json",
          "user-agent": "openai-node/4.50.0",
          "x-stainless-lang": "js",
          "openai-organization": "org-xyz",
          "openai-project": "proj-abc",
          "openai-beta": "responses=v1",
        },
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi Max Mustermann" }] },
      });

      const sentHeaders = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
      expect(sentHeaders["user-agent"]).toBe("openai-node/4.50.0");
      expect(sentHeaders["x-stainless-lang"]).toBe("js");
      expect(sentHeaders["openai-organization"]).toBe("org-xyz");
      expect(sentHeaders["openai-project"]).toBe("proj-abc");
      expect(sentHeaders["openai-beta"]).toBe("responses=v1");
    });

    it("strips hop-by-hop and proxy-internal headers", async () => {
      const piiProxy = mkPiiProxy();
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      app = Fastify();
      registerAuth(app, { sharedKey: KEY });
      registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: {
          authorization: "Bearer sk-fake",
          "content-type": "application/json",
          host: "localhost:4711",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "proxy-authorization": "Basic abc",
          "x-pii-proxy-key": "internal-secret",
          "accept-encoding": "gzip, br",
        },
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

      const sentHeaders = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
      expect(sentHeaders["host"]).toBeUndefined();
      expect(sentHeaders["connection"]).toBeUndefined();
      expect(sentHeaders["transfer-encoding"]).toBeUndefined();
      expect(sentHeaders["proxy-authorization"]).toBeUndefined();
      expect(sentHeaders["x-pii-proxy-key"]).toBeUndefined();
      expect(sentHeaders["accept-encoding"]).toBeUndefined();
    });
  });

  it("keeps pseudonyms consistent across multiple text fields (single anonymise call)", async () => {
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
      new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerOpenaiChatPassthroughRoute(app, { piiProxy, fetchFn });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "Du hilfst Max Mustermann." },
          { role: "user", content: "Was hat Max Mustermann gefragt?" },
          { role: "assistant", content: "Max Mustermann fragte nach X." },
        ],
      },
    });

    expect(anonCalls).toHaveLength(1); // boundary-joined, single call
    const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(sent.messages[0].content).toBe("Du hilfst [PERSON_A].");
    expect(sent.messages[1].content).toBe("Was hat [PERSON_A] gefragt?");
    expect(sent.messages[2].content).toBe("[PERSON_A] fragte nach X.");
  });
});
