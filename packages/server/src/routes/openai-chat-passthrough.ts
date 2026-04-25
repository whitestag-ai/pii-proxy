import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PiiProxy } from "@whitestag/pii-proxy-core";
import { createOpenaiSseDeanonymizer } from "../streaming/openai-sse-deanonymizer.js";

const OPENAI_UPSTREAM_DEFAULT = "https://api.openai.com/v1/chat/completions";

// OpenAI message-content block schemas. We anonymise text content; image_url
// and other modalities pass through verbatim. Tool-call arguments are
// intentionally NOT anonymised — they are JSON payloads the caller will parse
// and accidental rewrites would corrupt the call shape.
const TextPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const OtherPart = z.object({ type: z.string() }).passthrough();
const ContentPart = z.union([TextPart, OtherPart]);
const Content = z.union([z.string(), z.array(ContentPart), z.null()]);

const Message = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "developer", "function"]),
    content: Content.optional(),
  })
  .passthrough();

const RequestBody = z
  .object({
    model: z.string(),
    messages: z.array(Message),
    stream: z.boolean().optional(),
  })
  .passthrough();

export interface OpenaiChatPassthroughOptions {
  piiProxy: PiiProxy;
  fetchFn?: typeof fetch;
  upstreamUrl?: string;
  tenantId?: string;
}

type TextRef = { get: () => string; set: (value: string) => void };

function collectRequestTextRefs(body: z.infer<typeof RequestBody>): TextRef[] {
  const refs: TextRef[] = [];

  for (const m of body.messages) {
    const owner = m as { content?: unknown };
    const c = owner.content;
    if (typeof c === "string") {
      refs.push({
        get: () => owner.content as string,
        set: (v) => {
          owner.content = v;
        },
      });
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (isTextPart(part)) {
          const tp = part as { text: string };
          refs.push({ get: () => tp.text, set: (v) => { tp.text = v; } });
        }
      }
    }
    // null/undefined content (e.g. assistant message with only tool_calls) — skip.
  }

  return refs;
}

interface OpenaiNonStreamResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      role?: string;
      tool_calls?: unknown;
    };
  }>;
}

function collectResponseTextRefs(resp: OpenaiNonStreamResponse): TextRef[] {
  const refs: TextRef[] = [];
  const choices = resp.choices;
  if (!Array.isArray(choices)) return refs;
  for (const choice of choices) {
    const msg = choice.message;
    if (!msg) continue;
    if (typeof msg.content === "string") {
      refs.push({ get: () => msg.content as string, set: (v) => { msg.content = v; } });
    }
    // null content (tool-only assistant) — nothing to deanonymise.
  }
  return refs;
}

function isTextPart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function buildBoundary(): string {
  return ` ---PII-PROXY-BOUNDARY-${randomUUID()}--- `;
}

function ensureBoundaryAbsent(boundary: string, texts: string[]): string {
  let b = boundary;
  while (texts.some((t) => t.includes(b))) b = buildBoundary();
  return b;
}

// Strip the same hop-by-hop / proxy-internal headers as the Anthropic route.
// `accept-encoding` is stripped so SSE chunks arrive uncompressed.
const STRIP_HEADER_NAMES = new Set<string>([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "x-pii-proxy-key",
  "accept-encoding",
]);

/**
 * Forward all request headers to the upstream provider, except hop-by-hop
 * headers and proxy-internal secrets. OpenAI clients (openai-node, openai-python,
 * the Codex CLI, …) attach metadata (`user-agent`, `x-stainless-*`,
 * `openai-organization`, `openai-project`, `openai-beta`) that the upstream
 * uses to route, bill, and authenticate; stripping them via a narrow
 * whitelist breaks legitimate requests, so the route forwards everything
 * outside the strip-list verbatim.
 */
function buildUpstreamHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (STRIP_HEADER_NAMES.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  if (!out["content-type"]) out["content-type"] = "application/json";
  return out;
}

export function registerOpenaiChatPassthroughRoute(
  app: FastifyInstance,
  opts: OpenaiChatPassthroughOptions,
): void {
  const fetchFn = opts.fetchFn ?? fetch;
  const upstream = opts.upstreamUrl ?? OPENAI_UPSTREAM_DEFAULT;

  app.post(
    "/openai/v1/chat/completions",
    { config: { noAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
      const apiKey = typeof req.headers["api-key"] === "string" ? req.headers["api-key"] : "";
      if (!auth && !apiKey) {
        return reply.code(401).send({
          error: { type: "invalid_request_error", message: "missing authorization header" },
        });
      }

      const parsed = RequestBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "bad_request",
            details: parsed.error.flatten(),
          },
        });
      }

      const body = parsed.data;
      const isStreaming = body.stream === true;

      const refs = collectRequestTextRefs(body);
      const originals = refs.map((r) => r.get());

      // No text to anonymise (e.g. tool-result-only conversation continuation,
      // image-only request) — forward verbatim without consuming a mapping.
      if (refs.length === 0) {
        return forwardVerbatim(fetchFn, upstream, buildUpstreamHeaders(req), body, reply);
      }

      const boundary = ensureBoundaryAbsent(buildBoundary(), originals);
      const joined = originals.join(boundary);

      const anon = await opts.piiProxy.anonymize({
        text: joined,
        targetLlm: body.model,
        agent: "openai-chat-passthrough",
        tenantId: opts.tenantId,
      });
      if ("blocked" in anon) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `blocked_by_pii_proxy:${anon.reason}`,
          },
        });
      }

      const anonParts = anon.anonymizedText.split(boundary);
      if (anonParts.length !== refs.length) {
        return reply.code(500).send({
          error: {
            type: "api_error",
            message: `boundary-split mismatch (expected ${refs.length}, got ${anonParts.length})`,
          },
        });
      }
      for (let i = 0; i < refs.length; i++) refs[i].set(anonParts[i]);

      if (!isStreaming) {
        return forwardNonStreaming(
          fetchFn,
          upstream,
          buildUpstreamHeaders(req),
          body,
          reply,
          opts.piiProxy,
          anon.mappingId,
        );
      }

      const mappingTable = opts.piiProxy.getMappingTable(anon.mappingId);
      return forwardStreaming(
        fetchFn,
        upstream,
        buildUpstreamHeaders(req),
        body,
        reply,
        mappingTable,
      );
    },
  );
}

async function forwardVerbatim(
  fetchFn: typeof fetch,
  upstream: string,
  headers: Record<string, string>,
  body: unknown,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const res = await fetchFn(upstream, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  reply.code(res.status);
  reply.header("content-type", res.headers.get("content-type") ?? "application/json");
  return reply.send(text);
}

async function forwardNonStreaming(
  fetchFn: typeof fetch,
  upstream: string,
  headers: Record<string, string>,
  body: unknown,
  reply: FastifyReply,
  piiProxy: PiiProxy,
  mappingId: string,
): Promise<FastifyReply> {
  let upstreamRes: Response;
  try {
    upstreamRes = await fetchFn(upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({
      error: { type: "api_error", message: `upstream_unreachable: ${message}` },
    });
  }

  const rawText = await upstreamRes.text();
  if (!upstreamRes.ok) {
    reply.code(upstreamRes.status);
    reply.header("content-type", upstreamRes.headers.get("content-type") ?? "application/json");
    return reply.send(rawText);
  }

  let jsonResp: OpenaiNonStreamResponse & Record<string, unknown>;
  try {
    jsonResp = JSON.parse(rawText) as OpenaiNonStreamResponse & Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({
      error: { type: "api_error", message: `upstream_invalid_json: ${message}` },
    });
  }

  const respRefs = collectResponseTextRefs(jsonResp);
  for (const ref of respRefs) {
    const deanon = piiProxy.deanonymize({ mappingId, text: ref.get() });
    ref.set(deanon.text);
  }

  reply.code(200);
  reply.header("content-type", "application/json");
  return reply.send(jsonResp);
}

async function forwardStreaming(
  fetchFn: typeof fetch,
  upstream: string,
  headers: Record<string, string>,
  body: unknown,
  reply: FastifyReply,
  mappingTable: Map<string, string>,
): Promise<FastifyReply> {
  let upstreamRes: Response;
  try {
    upstreamRes = await fetchFn(upstream, {
      method: "POST",
      headers: { ...headers, accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({
      error: { type: "api_error", message: `upstream_unreachable: ${message}` },
    });
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    reply.code(upstreamRes.status);
    reply.header("content-type", upstreamRes.headers.get("content-type") ?? "application/json");
    return reply.send(text);
  }
  if (!upstreamRes.body) {
    return reply.code(502).send({
      error: { type: "api_error", message: "upstream response has no body" },
    });
  }

  reply.code(200);
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.flushHeaders();

  // OpenAI's chat-completions stream uses the SSE default `message` event —
  // i.e. only `data:` lines, no `event:` field. Mirror that on the way back
  // so clients (openai-node, openai-python, raw `curl --no-buffer`) parse
  // the response identically to a direct upstream call.
  const writeSse = (_event: string, data: string): void => {
    reply.raw.write(`data: ${data}\n\n`);
  };

  const pipeline = createOpenaiSseDeanonymizer({
    mappingTable,
    writeEvent: writeSse,
  });

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) pipeline.write(decoder.decode(value, { stream: true }));
    }
    pipeline.write(decoder.decode());
    pipeline.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      writeSse(
        "message",
        JSON.stringify({
          error: { type: "api_error", message: `upstream_stream_error: ${message}` },
        }),
      );
    } catch {
      /* best-effort */
    }
  } finally {
    reply.raw.end();
  }

  return reply;
}
