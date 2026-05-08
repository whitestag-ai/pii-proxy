# @whitestag/pii-proxy-server

Fastify HTTP server exposing pii-proxy-core over the network. Anonymises prompts before they reach cloud LLMs and de-anonymises the streamed response.

For the cross-repo overview, see [`../../README.md`](../../README.md).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Status (classifier reachable, etc.) |
| POST | `/anonymize` | `X-PII-Proxy-Key` | Pseudonymise text |
| POST | `/deanonymize` | `X-PII-Proxy-Key` | Restore plaintext from pseudonyms |
| POST | `/safe-call` | `X-PII-Proxy-Key` | Roundtrip (anon → external → deanon) |
| POST | `/anthropic/v1/messages` | `X-PII-Proxy-Key` | Streaming passthrough to Claude |
| POST | `/v1/chat/completions` | `X-PII-Proxy-Key` | Streaming passthrough to OpenAI |

## Prerequisites

- **Node.js 22 LTS** (recommended) or 20 LTS
- `pnpm` via `corepack enable`
- **Windows only:** Visual Studio Build Tools 2022 with the "Desktop development with C++" workload + Python 3
  - Required because `better-sqlite3` and `keytar` may need to compile from source if no prebuild matches your Node version. Node 22 LTS has prebuilds — `pnpm install` usually completes without compiling.

## Install as a service

The same command runs on all OSes. It detects `process.platform` and dispatches to launchd, systemd, or `node-windows`.

### 1. Generate keys

```bash
# Shared key for the X-PII-Proxy-Key header
node scripts/generate-shared-key.mjs

# AES key for the mapping store (base64-encoded, exactly 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2. Install

**macOS / Linux:**
```bash
PII_PROXY_SHARED_KEY="<shared>" \
PII_PROXY_MAPPING_KEY_BASE64="<mapping>" \
node scripts/install-service.mjs
```

**Windows (PowerShell, Administrator):**
```powershell
$env:PII_PROXY_SHARED_KEY = "<shared>"
$env:PII_PROXY_MAPPING_KEY_BASE64 = "<mapping>"
node scripts/install-service.mjs
```

Optional flags:
- `--dry-run` — print the would-be plist / systemd unit / Windows service config without touching the system.
- `--platform=darwin|linux|win32` — force a specific OS branch (mainly for testing).
- `--system` — Linux only: install as system service in `/etc/systemd/system/` instead of user-level.

### 3. Verify

```bash
PII_PROXY_SHARED_KEY="<shared>" node scripts/smoke.mjs
# or remote:
PII_PROXY_SHARED_KEY="<shared>" node scripts/smoke.mjs http://192.168.2.10:4711
```

### 4. Uninstall

```bash
node scripts/uninstall-service.mjs
```

## Where data lives

| OS | Data | Logs |
|---|---|---|
| macOS | `~/Library/Application Support/pii-proxy/` | `~/Library/Logs/pii-proxy/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/pii-proxy/` | `${XDG_STATE_HOME:-~/.local/state}/pii-proxy/logs/` |
| Windows | `%LOCALAPPDATA%\pii-proxy\` | `%LOCALAPPDATA%\pii-proxy\logs\` |

## Environment variables

See the full list in [`docs/CONFIG.md`](../../docs/CONFIG.md). Required for service install:

| Var | Purpose |
|---|---|
| `PII_PROXY_SHARED_KEY` | Shared secret, ≥ 32 chars |
| `PII_PROXY_MAPPING_KEY_BASE64` | AES-256 key, base64-encoded, decodes to exactly 32 bytes |

The installer also sets `PII_PROXY_MAPPING_DB` and `PII_PROXY_AUDIT_DIR` to the platform-appropriate paths above.

## Docker

Docker remains the simplest deployment for production — see the main [README](../../README.md#docker).
