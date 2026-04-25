# Docker-Compose: pii-proxy + Ollama (all-in-one)

Spins up a self-contained pii-proxy stack for evaluation. No external model
server required — Ollama runs in a sibling container and the classifier
model is pulled on first start.

## Prerequisites

- Docker + Docker Compose v2
- ~15 GB free disk (for `gemma2:9b`) — or pick a smaller model via `OLLAMA_MODEL`
- First-run model pull takes ~3–5 min on a decent connection

## Quick start

```bash
# 1) Generate per-install secrets (one-off)
export PII_PROXY_SHARED_KEY=$(openssl rand -base64 32 | tr -d '=/+' | cut -c1-43)
export PII_PROXY_MAPPING_KEY_BASE64=$(openssl rand -base64 32)

# 2) Optionally pick a different classifier model
# export OLLAMA_MODEL=gemma2:2b   # ~2 GB — faster, lower accuracy

# 3) Up
docker compose up -d

# 4) Wait for the init container to finish the model pull
docker compose logs -f ollama-pull
# ...when you see "done", ctrl-C and continue.

# 5) Smoke-test
curl http://localhost:4711/health
# → {"status":"ok","classifier":"reachable"}

# 6) Try a classify-and-anonymise call
curl -X POST http://localhost:4711/anonymize \
  -H "x-pii-proxy-key: $PII_PROXY_SHARED_KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Hi, can you email Max Mustermann at max@example.de?","targetLlm":"gpt-4o","agent":"demo"}'
```

## Where do I put my Anthropic API key?

You don't — **the pii-proxy itself is stateless for upstream credentials**.
Each client request (e.g. from the Claude CLI or your own app) carries its
own `x-api-key` / `Authorization` header, which the proxy passes through to
Anthropic/OpenAI/etc. You only persist secrets on the *client* side.

## What happens if the classifier is down?

Fail-closed: every call to `/anonymize` returns
`{"blocked":true,"reason":"classifier_unavailable"}`. Callers must handle
this — PII never leaves the machine because the anonymisation step itself
refused to run.

## Replacing Ollama with LM Studio or a remote host

Drop the `ollama` + `ollama-pull` services from the compose file and point
`PII_PROXY_CLASSIFIER_URL` at your real classifier. The single-container
compose at [../../packages/server/deploy/docker/docker-compose.yml](../../packages/server/deploy/docker/docker-compose.yml)
already does this — it targets `host.docker.internal:11434` by default, so
Ollama running on your Mac works without any other config.

## Teardown

```bash
docker compose down            # keep the mapping store + model cache
docker compose down -v         # wipe everything (irrecoverable for decrypted mappings!)
```

## License

Apache-2.0 — same as the rest of the project.
