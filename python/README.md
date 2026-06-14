# pii-proxy (Python)

Python client for [pii-proxy](https://github.com/whitestag-ai/pii-proxy) — a GDPR-compliant anonymisation gate for LLM calls.

```bash
pip install pii-proxy
```

See the [monorepo README](../README.md) for full documentation.

## Development

Requires **Python 3.11 or newer** (see `requires-python` in `pyproject.toml`). On macOS the system Python is usually 3.9 — install a newer one via Homebrew (`brew install python@3.11`) or pyenv.

```bash
cd pii-proxy/python
python3.11 -m venv .venv
```

**macOS / Linux:**
```bash
source .venv/bin/activate
```

**Windows (PowerShell):**
```powershell
.venv\Scripts\Activate.ps1
```

**All OSes** (note the quotes — without them zsh interprets the brackets as a glob):
```bash
pip install -e ".[dev]"
pytest
```
