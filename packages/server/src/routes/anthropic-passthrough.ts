import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PiiProxy } from "@whitestag/pii-proxy-core";
import { createStreamDeanonymizer } from "@whitestag/pii-proxy-core";
import { createSseParser } from "../streaming/sse-parser.js";

const ANTHROPIC_UPSTREAM_DEFAULT = "https://api.anthropic.com/v1/messages";

const TextBlock = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const OtherBlock = z.object({ type: z.string() }).passthrough();
const ContentBlock = z.union([TextBlock, OtherBlock]);
const Content = z.union([z.string(), z.array(ContentBlock)]);

const Message = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: Content,
  })
  .passthrough();

const RequestBody = z
  .object({
    model: z.string(),
    messages: z.array(Message),
    system: z.union([z.string(), z.array(ContentBlock)]).optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export interface AnthropicPassthroughOptions {
  piiProxy: PiiProxy;
  fetchFn?: typeof fetch;
  upstreamUrl?: string;
  tenantId?: string;
}

type TextRef = { get: () => string; set: (value: string) => void };

function collectRequestTextRefs(body: z.infer<typeof RequestBody>): TextRef[] {
  const refs: TextRef[] = [];

  const pushContent = (owner: { content: unknown }) => {
    const c = owner.content;
    if (typeof c === "string") {
      refs.push({
        get: () => owner.content as string,
        set: (v) => {
          owner.content = v;
        },
      });
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (isTextBlock(block)) {
          const tb = block as { text: string };
          refs.push({ get: () => tb.text, set: (v) => { tb.text = v; } });
        }
      }
    }
  };

  if (body.system !== undefined) {
    if (typeof body.system === "string") {
      refs.push({
        get: () => body.system as string,
        set: (v) => {
          body.system = v;
        },
      });
    } else {
      for (const block of body.system) {
        if (isTextBlock(block)) {
          const tb = block as { text: string };
          refs.push({ get: () => tb.text, set: (v) => { tb.text = v; } });
        }
      }
    }
  }

  for (const m of body.messages) pushContent(m as { content: unknown });
  return refs;
}

function collectResponseTextRefs(resp: { content?: unknown }): TextRef[] {
  const refs: TextRef[] = [];
  const c = resp.content;
  if (Array.isArray(c)) {
    for (const block of c) {
      if (isTextBlock(block)) {
        const tb = block as { text: string };
        refs.push({ get: () => tb.text, set: (v) => { tb.text = v; } });
      }
    }
  }
  return refs;
}

function isTextBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
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

/**
 * Forward the minimal safe header set to the upstream provider. We
 * explicitly whitelist headers so local-proxy secrets never leak upstream.
 */
function buildUpstreamHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") headers["x-api-key"] = apiKey;
  const auth = req.headers["authorization"];
  if (typeof auth === "string") headers["authorization"] = auth;
  const anthroVersion = req.headers["anthropic-version"];
  headers["anthropic-version"] = typeof anthroVersion === "string" ? anthroVersion : "2023-06-01";
  const anthroBeta = req.headers["anthropic-beta"];
  if (typeof anthroBeta === "string") headers["anthropic-beta"] = anthroBeta;
  return headers;
}

export function registerAnthropicPassthroughRoute(
  app: FastifyInstance,
  opts: AnthropicPassthroughOptions,
): void {
  const fetchFn = opts.fetchFn ?? fetch;
  const upstream = opts.upstreamUrl ?? ANTHROPIC_UPSTREAM_DEFAULT;

  app.post(
    "/anthropic/v1/messages",
    { config: { noAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
      const authHeader =
        typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
      if (!apiKey && !authHeader) {
        return reply.code(401).send({
          type: "error",
          error: { type: "authentication_error", message: "missing x-api-key or authorization" },
        });
      }

      const parsed = RequestBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "error",
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

      // No text to anonymize (image-only) — forward verbatim.
      if (refs.length === 0) {
        return forwardVerbatim(fetchFn, upstream, buildUpstreamHeaders(req), body, reply);
      }

      const boundary = ensureBoundaryAbsent(buildBoundary(), originals);
      const joined = originals.join(boundary);

      const anon = await opts.piiProxy.anonymize({
        text: joined,
        targetLlm: body.model,
        agent: "anthropic-passthrough",
        tenantId: opts.tenantId,
      });
      if ("blocked" in anon) {
        return reply.code(400).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `blocked_by_pii_proxy:${anon.reason}`,
          },
        });
      }

      const anonParts = anon.anonymizedText.split(boundary);
      if (anonParts.length !== refs.length) {
        return reply.code(500).send({
          type: "error",
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
      type: "error",
      error: { type: "api_error", message: `upstream_unreachable: ${message}` },
    });
  }

  const rawText = await upstreamRes.text();
  if (!upstreamRes.ok) {
    reply.code(upstreamRes.status);
    reply.header("content-type", upstreamRes.headers.get("content-type") ?? "application/json");
    return reply.send(rawText);
  }

  let jsonResp: Record<string, unknown>;
  try {
    jsonResp = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({
      type: "error",
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
      type: "error",
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
      type: "error",
      error: { type: "api_error", message: "upstream response has no body" },
    });
  }

  reply.code(200);
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.flushHeaders();

  // One streaming deanonymizer per content_block index. Anthropic emits
  // content_block_start → content_block_delta* → content_block_stop for
  // each block (text, tool_use, ...). We only rewrite text-delta payloads.
  const perBlockStreams = new Map<number, ReturnType<typeof createStreamDeanonymizer>>();

  const writeSse = (event: string, data: string): void => {
    reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const parser = createSseParser();
  parser.setListener((evt) => {
    if (evt.event === "content_block_stop") {
      let idx: number | null = null;
      try {
        const payload = JSON.parse(evt.data) as Record<string, unknown>;
        if (typeof payload.index === "number") idx = payload.index;
      } catch {
        /* ignore malformed stop — forward verbatim below */
      }
      if (idx !== null) {
        const stream = perBlockStreams.get(idx);
        if (stream) {
          const tail = stream.end();
          perBlockStreams.delete(idx);
          if (tail.length > 0) {
            writeSse(
              "content_block_delta",
              JSON.stringify({
                type: "content_block_delta",
                index: idx,
                delta: { type: "text_delta", text: tail },
              }),
            );
          }
        }
      }
      writeSse(evt.event, evt.data);
      return;
    }

    if (evt.event !== "content_block_delta") {
      writeSse(evt.event, evt.data);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      writeSse(evt.event, evt.data);
      return;
    }

    const index = typeof payload.index === "number" ? payload.index : 0;
    const delta = payload.delta as Record<string, unknown> | undefined;
    if (
      !delta ||
      typeof delta !== "object" ||
      (delta.type !== "text_delta" && delta.type !== "text") ||
      typeof delta.text !== "string"
    ) {
      // Non-text delta (e.g. tool_use input_json_delta) — forward as-is.
      writeSse(evt.event, evt.data);
      return;
    }

    let stream = perBlockStreams.get(index);
    if (!stream) {
      stream = createStreamDeanonymizer(mappingTable);
      perBlockStreams.set(index, stream);
    }
    const emittedText = stream.write(delta.text as string);
    if (emittedText.length === 0) {
      // Buffer is holding back — don't emit anything for this delta.
      return;
    }
    const patched = { ...payload, delta: { ...delta, text: emittedText } };
    writeSse(evt.event, JSON.stringify(patched));
  });

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.write(decoder.decode(value, { stream: true }));
    }
    parser.write(decoder.decode());
    // Flush any still-open blocks (e.g. upstream ended without content_block_stop).
    for (const [idx, stream] of perBlockStreams.entries()) {
      const tail = stream.end();
      if (tail.length > 0) {
        writeSse(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: tail },
          }),
        );
      }
    }
    perBlockStreams.clear();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      writeSse(
        "error",
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `upstream_stream_error: ${message}` },
        }),
      );
    } catch {
      /* best-effort; ignore further failures */
    }
  } finally {
    reply.raw.end();
  }

  return reply;
}
