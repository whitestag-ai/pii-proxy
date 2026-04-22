# Tested Classifier Models

The classifier is an LLM that identifies person names, company names, trade secrets, and Art. 9 data. Regex detectors (emails, IBAN, phone, etc.) run independently and are provider-agnostic.

## Requirements

- Serves OpenAI-compatible `/v1/chat/completions` (Ollama, LM Studio, vLLM, Tabby, LocalAI all work)
- Instruction-tuned model with reliable JSON output
- German + English understanding
- ≥ 20B parameters recommended for acceptable precision

## Tested

| Model | Provider | URL | Notes |
|---|---|---|---|
| `google/gemma-4-26b-a4b` | LM Studio | `http://localhost:1234` | Default. Good precision, fast on Apple Silicon |
| `gemma2:27b` | Ollama | `http://localhost:11434` | Linux/server default. Close to Gemma 4, slightly lower precision |
| `qwen2.5:32b` | Ollama / LM Studio | — | Stronger German than Gemma 2 |
| `mistral-small:24b` | Ollama | — | Fastest with decent quality |

## Not recommended

- `llama3.1:8b` and smaller — too many false negatives on company names
- English-only fine-tunes — miss German legal/commercial terms
- `gpt-oss` / `deepseek-r1` reasoning models — too slow, unpredictable JSON output

## Switching provider

LM Studio is the macOS default because Apple Silicon acceleration works out of the box. For server deployments, Ollama is more scriptable.

Switch by setting env vars:

```
# Ollama
PII_PROXY_CLASSIFIER_URL=http://localhost:11434
PII_PROXY_CLASSIFIER_MODEL=gemma2:27b

# vLLM
PII_PROXY_CLASSIFIER_URL=http://vllm-host:8000
PII_PROXY_CLASSIFIER_MODEL=Qwen/Qwen2.5-32B-Instruct
```

## Reporting a model

If you test a new model and want it listed here, please open a PR with benchmark results: precision and recall for German + English names, companies, and Art. 9 data. Include the exact LM Studio / Ollama version and quantisation.
