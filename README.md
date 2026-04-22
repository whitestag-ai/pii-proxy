# pii-proxy

A GDPR-compliant anonymisation gate for LLM calls.

Detect and pseudonymise personal data (emails, phone numbers, names, company names, bank details, trade secrets) before sending prompts to Claude, OpenAI, Gemini, or any other cloud LLM. De-anonymise responses transparently. Block Art. 9 special-category data entirely. Log everything for GDPR Art. 30 processing records.

**Why:** If you're an EU company using cloud LLMs, your customer data shouldn't leave the continent in plaintext. `pii-proxy` is a drop-in HTTP gate that pseudonymises before egress and restores on return — without the LLM ever seeing real PII.

## Quick start

### Docker

```bash
curl -L -o docker-compose.yml \
  https://raw.githubusercontent.com/whitestag-ai/pii-proxy/main/packages/server/deploy/docker/docker-compose.yml

export PII_PROXY_SHARED_KEY=$(openssl rand -base64 32 | tr -d '=/+' | cut -c1-43)
export PII_PROXY_MAPPING_KEY_BASE64=$(openssl rand -base64 32)

docker compose up -d
curl http://localhost:4711/health
```

### macOS (launchd)

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install && pnpm build

export PII_PROXY_SHARED_KEY=$(./packages/server/scripts/generate-shared-key.sh)
security add-generic-password -s io.piiproxy.shared-key -a default -w "$PII_PROXY_SHARED_KEY"
./packages/server/scripts/install-launchd.sh

curl http://localhost:4711/health
```

### Linux (systemd)

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install && pnpm build

export PII_PROXY_SHARED_KEY=$(./packages/server/scripts/generate-shared-key.sh)
sudo -E ./packages/server/deploy/systemd/install-systemd.sh

systemctl status pii-proxy
```

## Usage

### TypeScript

```ts
import { createPiiProxyClient } from "@whitestag-ai/pii-proxy-core";

const client = createPiiProxyClient({
  baseUrl: "http://localhost:4711",
  sharedKey: process.env.PII_PROXY_SHARED_KEY!,
});

const result = await client.safeCall({
  prompt: "Hi, can you write a birthday email to Max Mustermann (max@example.com)?",
  targetLlm: "gpt-4o-mini",
  agent: "my-app",
  external: {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    bodyTemplate: {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "{{prompt}}" }],
    },
    responsePath: "choices.0.message.content",
  },
});

if (!result.blocked) console.log(result.text);
```

### Python

```python
from pii_proxy import PiiProxyClient

client = PiiProxyClient(base_url="http://localhost:4711", shared_key=...)
result = client.safe_call(
    prompt="Hi, can you write ...",
    target_llm="gpt-4o-mini",
    agent="my-app",
    external={
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": {"Authorization": f"Bearer {OPENAI_API_KEY}"},
        "bodyTemplate": {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "{{prompt}}"}]},
        "responsePath": "choices.0.message.content",
    },
)
```

### curl

```bash
curl -X POST http://localhost:4711/anonymize \
  -H "x-pii-proxy-key: $PII_PROXY_SHARED_KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Max Mustermann (max@example.com)","targetLlm":"gpt-4o","agent":"curl"}'
```

## How it works

Two-stage pipeline:

1. **Regex detectors** — deterministic, zero-latency: emails, phone numbers (DE), IBAN, BIC, VAT-ID, tax numbers, postcodes, URLs.
2. **LLM classifier** (local, via LM Studio or Ollama) — detects: person names, company names, places, trade secrets (revenues, margins, prices, salaries, customer relationships), Art. 9 data (health, religion, biometrics, …).

Pseudonyms are consistent within a session (same name → same `[PERSON_A]`). The mapping table is AES-256-GCM encrypted on disk, keyed from the OS keychain or an env var. A JSONL audit log records what was sent to which LLM, when, and by which agent — the source data for GDPR Art. 30 records of processing.

On Art. 9 detection or classifier outage, requests are **blocked** (fail-closed). Never falls through silently.

## Components

| Package | What | Install |
|---|---|---|
| [`@whitestag-ai/pii-proxy-core`](packages/core/) | TS library: detectors, classifier, mapping store | `pnpm add @whitestag-ai/pii-proxy-core` |
| [`@whitestag-ai/pii-proxy-server`](packages/server/) | Fastify HTTP gate | `docker pull ghcr.io/whitestag-ai/pii-proxy` |
| [`pii-proxy`](python/) (PyPI) | Python HTTP client | `pip install pii-proxy` |
| [`paperclip-plugin-pii-proxy`](https://github.com/whitestag-ai/paperclip-plugin-pii-proxy) | Paperclip integration | separate repo |

## Documentation

- [Configuration reference](docs/CONFIG.md) — all env vars
- [Tested classifier models](docs/MODELS.md) — Ollama, LM Studio, etc.
- [Integrations](docs/INTEGRATIONS.md) — n8n, LangChain, raw HTTP
- [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## GDPR reference

| Article | Implementation |
|---|---|
| Art. 25 (Privacy by design) | pii-proxy itself is the technical measure |
| Art. 28 (Processor oversight) | Audit log documents every egress |
| Art. 30 (Records of processing) | Audit log is the data source |
| Art. 32 (Pseudonymisation) | AES-256-GCM mapping store |
| Art. 9 (Special categories) | Fail-closed veto mode |

## License

Apache-2.0 © WHITESTAG.AI
