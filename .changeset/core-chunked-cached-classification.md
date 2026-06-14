---
"@whitestag/pii-proxy-core": minor
---

feat(core): chunked + cached PII classification and reasoning_content fallback

The accurate LLM classifier (gemma) timed out on full agent prompts in a single
call, so the proxy failed closed and blocked every real run. The classification
path is now structural:

- **Chunked classification (`classifier-chunk-cache.ts`):** the LLM-classifier
  input is split on safe boundaries (paragraph > line > sentence,
  `MAX_CHUNK_CHARS = 4000`), each chunk is classified separately, and findings
  are cached per `sha256` chunk hash (TTL 1h, LRU max 512). The identical static
  system/skills prefix is classified once per unique chunk and then served from
  cache; small dynamic message chunks classify fast. Findings are merged and
  de-duped by `(type, value)`; each value stays an exact substring of the full
  input so value-based anonymisation is unchanged.
- **`reasoning_content` fallback (`entity-classifier.ts`):** falls back to
  `message.reasoning_content` when `content` is empty/whitespace (reasoning
  models such as qwen3), and extracts JSON robustly from prose / thinking-tag
  wrapping. If neither is parseable, the existing fail-closed
  `ClassifierUnavailableError` is preserved.

GDPR behaviour is unchanged: regex detectors still run on the full text, the
Art. 9 block threshold (high) is intact, and fail-closed on real classifier
errors is preserved (a chunk whose classifier call throws is never cached).
