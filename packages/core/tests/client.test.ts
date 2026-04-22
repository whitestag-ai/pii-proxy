import { describe, it, expect, vi } from "vitest";
import { createPiiProxyClient } from "../src/client.js";

const KEY = "client-test-key-32-bytes-xxxxxxxxx";

describe("createPiiProxyClient", () => {
  it("anonymize POSTs with X-PII-PROXY-Key and returns body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: false, anonymizedText: "a", mappingId: "m" }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createPiiProxyClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.anonymize({ text: "t", targetLlm: "l", agent: "a" });
    expect(out).toEqual({ blocked: false, anonymizedText: "a", mappingId: "m" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://x:4711/anonymize");
    expect(init.method).toBe("POST");
    expect(init.headers["x-pii-proxy-key"]).toBe(KEY);
  });

  it("deanonymize returns { text }", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "back" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createPiiProxyClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.deanonymize({ mappingId: "m", text: "x" });
    expect(out).toEqual({ text: "back" });
  });

  it("safeCall passes external payload through", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: false, text: "done" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createPiiProxyClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.safeCall({
      prompt: "p", targetLlm: "t", agent: "a",
      external: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {}, bodyTemplate: { content: "{{prompt}}" },
        responsePath: "content",
      },
    });
    expect(out).toEqual({ blocked: false, text: "done" });
  });

  it("propagates blocked response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: true, reason: "art_9_data_detected" }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createPiiProxyClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.anonymize({ text: "t", targetLlm: "l", agent: "a" });
    expect(out).toEqual({ blocked: true, reason: "art_9_data_detected" });
  });

  it("throws on non-2xx (except blocked-200)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = createPiiProxyClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    await expect(client.anonymize({ text: "t", targetLlm: "l", agent: "a" }))
      .rejects.toThrow(/401/);
  });
});
