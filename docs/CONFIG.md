# Configuration Reference

All configuration is via environment variables.

## Required

| Var | Description |
|---|---|
| `PII_PROXY_SHARED_KEY` | Shared secret for the `X-PII-Proxy-Key` header on protected endpoints. Must be at least 32 characters. Generate with `./packages/server/scripts/generate-shared-key.sh` |

## Classifier

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_CLASSIFIER_URL` | `http://localhost:1234` | LM Studio or Ollama endpoint. For Ollama use `http://localhost:11434`. |
| `PII_PROXY_CLASSIFIER_MODEL` | `google/gemma-4-26b-a4b` | Model ID as listed by the provider's `/v1/models`. For Ollama: `gemma2:27b`, `llama3.1:70b`, etc. |
| `PII_PROXY_CLASSIFIER_TIMEOUT_MS` | `30000` | Per-classification timeout |

See [MODELS.md](MODELS.md) for tested combinations.

## Storage

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_MAPPING_DB` | `~/.pii-proxy/mappings.db` | SQLite path for the pseudonym mapping table |
| `PII_PROXY_AUDIT_DIR` | `~/.pii-proxy/audit` | Directory for daily JSONL audit logs (file `pii-proxy-YYYY-MM-DD.jsonl`) |
| `PII_PROXY_MAPPING_KEY_BASE64` | — | 32-byte AES key, base64-encoded. If set, overrides the OS keychain lookup. **Required in Docker** (no keychain). Generate: `openssl rand -base64 32` |

In containers without a keychain (Docker, most Linux CI), set `PII_PROXY_MAPPING_KEY_BASE64` explicitly and persist it across restarts — otherwise existing mappings cannot be decrypted after restart.

## Network

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_PORT` | `4711` | HTTP listen port |
| `PII_PROXY_BIND` | `0.0.0.0` | Listen interface. Use `127.0.0.1` for loopback-only |

## Alerts (optional)

| Var | Description |
|---|---|
| `PII_PROXY_TELEGRAM_BOT_TOKEN` | Bot token for Art. 9 / classifier-down alerts. Leave unset to log to stderr instead. |
| `PII_PROXY_TELEGRAM_CHAT_ID` | Destination chat ID |

Both must be set to activate Telegram alerts. Triggers: Art. 9 block (immediate), classifier unreachable 3× consecutive, >10 blocks/h.

## Example `.env`

```
PII_PROXY_SHARED_KEY=generated-43-char-base64url-string
PII_PROXY_MAPPING_KEY_BASE64=generated-32-byte-base64
PII_PROXY_CLASSIFIER_URL=http://localhost:11434
PII_PROXY_CLASSIFIER_MODEL=gemma2:27b
PII_PROXY_BIND=127.0.0.1
```
