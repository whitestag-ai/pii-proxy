---
"@whitestag/pii-proxy-core": minor
---

feat(core): credit-card and API-key/secret regex PII detectors

Adds two regex detectors and wires them into the default rules so they actually
run at request time:

- **Credit-card detector** (`detectors/creditcard.ts`): matches the common
  card-number formats and validates the Luhn checksum to cut false positives.
- **API-key / secret detector** (`detectors/apikey.ts`): matches common
  provider key shapes (e.g. `sk-…`, generic high-entropy tokens) so secrets are
  pseudonymised instead of leaking to the upstream LLM.
- **Default-rules wiring** (`pii-proxy-rules.default.yaml`): both detectors are
  added to the default allowlist. Without this they were defined but never
  active — credit-card numbers and API keys passed through in plaintext. A
  `rules-detectors-wired` test now locks the end-to-end rules path.
