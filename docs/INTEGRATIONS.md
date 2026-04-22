# Integrations

## n8n

Import the example workflow at `examples/n8n-pii-proxy-workflow.json` as a sub-workflow. It takes `{ prompt, targetLlm, model, agent }` and returns `{ blocked, text }`.

**Parent workflow change:** replace your direct OpenAI HTTP node with an "Execute Workflow" node pointing to the imported sub-workflow.

**Credentials:**

1. Create HTTP Header Auth credential: header `X-PII-Proxy-Key`, value = your `PII_PROXY_SHARED_KEY`
2. Assign to the two `anonymize` / `deanonymize` HTTP nodes in the sub-workflow

## LangChain (Python)

```python
from langchain_openai import ChatOpenAI
from pii_proxy import PiiProxyClient

proxy = PiiProxyClient(base_url="http://localhost:4711", shared_key=KEY)

def anonymised_chat(prompt: str) -> str:
    anon = proxy.anonymize(text=prompt, target_llm="gpt-4o", agent="langchain")
    if anon.blocked:
        raise RuntimeError(f"pii-proxy blocked: {anon.reason}")
    reply = ChatOpenAI(model="gpt-4o").invoke(anon.anonymized_text)
    return proxy.deanonymize(mapping_id=anon.mapping_id, text=reply.content)
```

## Raw HTTP from any language

`/safe-call` is the one-shot endpoint — anonymise, call external, deanonymise, all in the server. Client only needs to POST JSON and read JSON.

```bash
curl -X POST http://localhost:4711/safe-call \
  -H "x-pii-proxy-key: $PII_PROXY_SHARED_KEY" \
  -H "content-type: application/json" \
  -d '{
    "prompt": "Write to Max Mustermann (max@example.com)",
    "targetLlm": "gpt-4o",
    "agent": "my-bash-script",
    "external": {
      "url": "https://api.openai.com/v1/chat/completions",
      "headers": {"Authorization": "Bearer sk-..."},
      "bodyTemplate": {"model":"gpt-4o","messages":[{"role":"user","content":"{{prompt}}"}]},
      "responsePath": "choices.0.message.content"
    }
  }'
```

## Paperclip

Use the separate [`paperclip-plugin-pii-proxy`](https://github.com/whitestag-ai/paperclip-plugin-pii-proxy) repo.
