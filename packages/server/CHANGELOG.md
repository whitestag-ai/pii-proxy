# @whitestag/pii-proxy-server

## 0.4.0

### Minor Changes

- 6ba209c: feat(server): OpenAI Chat-Completions passthrough with PII-scrubbing + streaming

  Adds a new endpoint `POST /openai/v1/chat/completions` that mirrors the
  existing Anthropic passthrough for the OpenAI Chat-Completions API. Clients
  that speak OpenAI's protocol (`openai-node`, `openai-python`, the OpenAI
  Codex CLI, …) can now point `OPENAI_BASE_URL` at the proxy and have their
  prompts pseudonymised on the way out and responses de-pseudonymised on the
  way back in — non-streaming JSON or SSE streams alike.

  Highlights:

  - **Request anonymisation:** anonymises `messages[].content` for both
    string and content-part array shapes (`{type:"text", text}` blocks).
    Image/audio parts and tool-call arguments pass through unchanged so JSON
    payloads remain machine-parseable downstream.
  - **Streaming pipeline:** new `createOpenaiSseDeanonymizer` reassembles
    pseudonyms split across chunk boundaries on a per-`choices[i]` basis
    (n>1 supported, byte-by-byte chunking covered, malformed JSON forwarded
    verbatim, `[DONE]` sentinel preserved).
  - **Header forwarding:** same blacklist as the Anthropic route — full SDK
    metadata (`user-agent`, `x-stainless-*`, `openai-organization`,
    `openai-project`, `openai-beta`) reaches upstream so OpenAI can authenticate
    and route correctly. Hop-by-hop and `accept-encoding` are stripped.
  - **Tool-only continuations:** assistant messages with `content: null` are
    recognised and forwarded without spuriously consuming a mapping.

  22 new tests (12 streaming pipeline + 10 route integration). Total server
  suite: 117/117 green.

## 0.3.0

### Minor Changes

- d68a0d3: feat: Anthropic /v1/messages passthrough with PII-scrubbing + streaming

  Adds a streaming-capable Anthropic-compatible passthrough endpoint that lets
  clients speaking the Anthropic API (SDK, Claude CLI) be transparently routed
  through the pii-proxy: prompts are anonymised on the way out, responses
  deanonymised on the way back in — including SSE streams (per-block
  deanonymisation, fuzz-tested against random chunk boundaries).

  Core (`@whitestag/pii-proxy-core`):

  - `extractSafePrefix(buffer, mappings, options?)` — pure function returning
    the longest safely-emittable prefix and the remainder to carry forward.
    Never leaks a partial `[PSEUDONYM]`.
  - `flushStreamRemainder(remainder, mappings)` — end-of-stream flush helper.
  - `createStreamDeanonymizer(mappings, options?)` — stateful wrapper with
    `write(delta)` / `end()` API.
  - `PiiProxy.getMappingTable(mappingId)` — returns
    `Map<pseudonym, plaintext>` for token-level lookup without per-call DB
    round trips.
  - Handles pseudonyms split across any chunk boundary (incl. byte-by-byte),
    underscore-containing TYPEs (`UST_ID`, `ART_9`), multi-letter labels,
    unmapped pseudonyms (pass-through literal), nested brackets.

  Server (`@whitestag/pii-proxy-server`):

  - `POST /anthropic/v1/messages` — anonymises text content blocks +
    `system`, forwards to `api.anthropic.com`, deanonymises the response
    (non-streaming JSON or SSE stream).
  - SSE frame parser for Anthropic's `content_block_delta` events.
  - Per-block streaming deanonymiser pipeline.
  - Forwards full SDK metadata headers upstream (`user-agent`,
    `x-stainless-*`, `anthropic-dangerous-direct-browser-access`, …) — earlier
    whitelist was too narrow and caused 401s that pushed clients toward
    alternate auth paths bypassing the proxy. Hop-by-hop and proxy-internal
    headers stay stripped.
  - All-in-one `docker-compose-with-ollama` example for first-time users.

### Patch Changes

- Updated dependencies [d68a0d3]
  - @whitestag/pii-proxy-core@0.3.0

## 0.2.1

### Patch Changes

- 355237e: Re-trigger release pipeline with corrected `publishedPackages` gate so
  that the GHCR Docker image and PyPI artefact are produced alongside the
  npm publish. Package contents are functionally identical to 0.2.0.
- Updated dependencies [355237e]
  - @whitestag/pii-proxy-core@0.2.1

## 0.2.0

### Minor Changes

- f720c2f: Initial public release.

  - @whitestag/pii-proxy-core: Library for PII detection, pseudonymisation, and mapping-store management
  - @whitestag/pii-proxy-server: Fastify HTTP server exposing anonymize/deanonymize/safe-call endpoints with X-PII-Proxy-Key auth

  See README for quick start and architecture overview.

### Patch Changes

- Updated dependencies [f720c2f]
  - @whitestag/pii-proxy-core@0.2.0

## 0.1.0

### Minor Changes

- Initial public release.
  - Fastify 4 HTTP gate on configurable port (default 4711)
  - Endpoints: `POST /anonymize`, `POST /deanonymize`, `POST /safe-call`, `GET /health`
  - `X-PII-Proxy-Key` shared-secret auth with `timingSafeEqual`
  - Monitor loop with Telegram alerts for Art. 9 blocks, classifier-down streaks, and error-rate bursts
  - Deploy assets: macOS launchd plist, Linux systemd unit, Dockerfile
