# Architecture

```
                  ┌──────────────┐
 client app ─────▶│  pii-proxy   │────▶  external LLM (OpenAI, Anthropic, …)
                  │   server     │
                  │   :4711      │
                  └───────┬──────┘
                          │
                  ┌───────┴──────┐
                  │              │
           ┌──────▼───┐   ┌──────▼──────┐
           │ regex    │   │ classifier  │
           │ detectors│   │ LLM (local) │
           └──────────┘   └─────────────┘
                  │
          ┌───────┴──────┐
          │ AES-256-GCM  │
          │ mapping store│
          └──────────────┘
                  │
          ┌───────┴──────┐
          │ JSONL audit  │
          └──────────────┘
```

## Data flow

1. Client POSTs a prompt to `/anonymize` (or `/safe-call`)
2. Server runs regex detectors for deterministic PII (emails, IBAN, phone, VAT-ID, BIC, tax IDs, postcodes, URLs)
3. Server calls the local classifier LLM to detect named entities and trade secrets
4. If Art. 9 data is detected → block, return `{ blocked: true, reason: "art_9_data_detected" }`
5. Otherwise, each detection is replaced with a consistent pseudonym (`[PERSON_A]`, `[FIRMA_1]`, `[EMAIL_A]`)
6. Pseudonym→plaintext mappings are AES-256-GCM encrypted and persisted to SQLite with the supplied `mappingId` and per-tenant TTL
7. Audit log writes one line of metadata (timestamp, agent, target LLM, detection counts, prompt hash) — never the plaintext itself
8. Server returns `{ anonymizedText, mappingId }` to the client (or forwards to the external LLM in `/safe-call`)
9. Client calls `/deanonymize` with the `mappingId` and the LLM response, receives plaintext back

## Fail-closed semantics

- Classifier unreachable → `{ blocked: true, reason: "classifier_unavailable" }`
- Art. 9 detected with confidence above threshold → immediate block + optional Telegram alert
- Unknown `mappingId` on `/deanonymize` → 404 (prevents silent leakage of untranslated pseudonyms)

## What pii-proxy does not do

- Prompt injection defence (the external LLM can still be manipulated post-gate)
- On-device LLM inference for the user prompts — only the classifier runs locally
- Audit log rotation / retention policy — configure externally (logrotate, cron job)
- Key rotation — manual (new `PII_PROXY_SHARED_KEY`, then restart)

## Threat model

Trusted:
- The host running pii-proxy
- The classifier LLM (but see [MODELS.md](MODELS.md) on jailbreak risks)
- The OS keychain / `PII_PROXY_MAPPING_KEY_BASE64`

Untrusted:
- The external LLM (that's the whole point)
- Network between client and pii-proxy (mitigation: bind to `127.0.0.1` or put behind mTLS proxy if LAN-exposed)
- Other processes on the host (mitigation: file permissions on mapping DB and audit log)
