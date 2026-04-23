# @whitestag/pii-proxy-core

## 0.2.1

### Patch Changes

- 355237e: Re-trigger release pipeline with corrected `publishedPackages` gate so
  that the GHCR Docker image and PyPI artefact are produced alongside the
  npm publish. Package contents are functionally identical to 0.2.0.

## 0.2.0

### Minor Changes

- f720c2f: Initial public release.

  - @whitestag/pii-proxy-core: Library for PII detection, pseudonymisation, and mapping-store management
  - @whitestag/pii-proxy-server: Fastify HTTP server exposing anonymize/deanonymize/safe-call endpoints with X-PII-Proxy-Key auth

  See README for quick start and architecture overview.

## 0.1.0

### Minor Changes

- Initial public release.
  - Regex PII detectors: email, phone (DE), IBAN, BIC, VAT-ID, tax IDs, postcode, URL
  - Gemma/Ollama classifier via OpenAI-compatible `/v1/chat/completions`
  - AES-256-GCM mapping store with per-tenant TTL, backed by SQLite
  - JSONL audit log (hashed prompts only; no plaintext)
  - `createPiiProxy({...})` and `createPiiProxyClient({...})` entry points
  - `MappingNotFoundError` + `ClassifierUnavailableError` for fail-closed semantics
