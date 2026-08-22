---
"@whitestag/pii-proxy-core": patch
---

fix(classifier): leere Modellantwort als transient behandeln statt fail-closed

Lokale Modelle (Gemma 4, qwen3.6) liefern gelegentlich eine komplett leere
Antwort: sowohl `content` als auch `reasoning_content` leer, dabei
`finish_reason: "stop"`. Bisher lief das in `parseClassifierResponse` auf
`null` und damit in `ClassifierUnavailableError("invalid_json")` — und das ist
per Definition nicht retrybar. Jeder solche Fall sprang deshalb sofort auf das
Fallback-Modell, und wenn auch das leer antwortete, wurde die Anfrage
fail-closed blockiert.

Gemessen am 2026-08-22 auf `gemma-4-12b-qat`: **783 von 3787 Antworten
(20,7 %)** waren komplett leer. Damit landete jede fünfte Klassifizierung
unnötig auf dem langsameren Fallback-Modell.

Der leere Fall wird jetzt vom unparsebaren getrennt und als
`ClassifierUnavailableError("empty_response", true)` geworfen — der vorhandene
Retry greift. Unparsebare, aber nicht-leere Antworten bleiben unverändert
nicht-retrybar, und das fail-closed-Verhalten nach erschöpften Retries bleibt
ebenfalls unverändert.
