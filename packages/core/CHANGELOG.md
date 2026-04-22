# @whitestag-ai/pii-proxy-core

## 0.1.0

### Minor Changes

- Initial public release.
  - Regex PII detectors: email, phone (DE), IBAN, BIC, VAT-ID, tax IDs, postcode, URL
  - Gemma/Ollama classifier via OpenAI-compatible `/v1/chat/completions`
  - AES-256-GCM mapping store with per-tenant TTL, backed by SQLite
  - JSONL audit log (hashed prompts only; no plaintext)
  - `createPiiProxy({...})` and `createPiiProxyClient({...})` entry points
  - `MappingNotFoundError` + `ClassifierUnavailableError` for fail-closed semantics
