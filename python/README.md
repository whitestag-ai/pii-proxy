# pii-proxy (Python)

Python client for [pii-proxy](https://github.com/whitestag-ai/pii-proxy) — a GDPR-compliant anonymisation gate for LLM calls.

```bash
pip install pii-proxy
```

See the [monorepo README](../README.md) for full documentation.

## Development

```bash
cd pii-proxy/python
python -m venv .venv
```

**macOS / Linux:**
```bash
source .venv/bin/activate
```

**Windows (PowerShell):**
```powershell
.venv\Scripts\Activate.ps1
```

**All OSes:**
```bash
pip install -e .[dev]
pytest
```
