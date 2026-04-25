---
"@whitestag/pii-proxy-server": minor
---

feat(server): OpenAI Chat-Completions passthrough with PII-scrubbing + streaming

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
