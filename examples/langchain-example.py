"""Minimal LangChain wrapper using pii-proxy."""
import os
from langchain_openai import ChatOpenAI
from pii_proxy import PiiProxyClient

proxy = PiiProxyClient(
    base_url=os.environ.get("PII_PROXY_URL", "http://localhost:4711"),
    shared_key=os.environ["PII_PROXY_SHARED_KEY"],
)


def privacy_safe_chat(prompt: str, model: str = "gpt-4o-mini") -> str:
    """Anonymise a prompt, send to OpenAI, deanonymise the response."""
    anon = proxy.anonymize(text=prompt, target_llm=model, agent="langchain-demo")
    if anon.blocked:
        raise RuntimeError(f"pii-proxy blocked: {anon.reason}")

    chat = ChatOpenAI(model=model, temperature=0.2)
    reply = chat.invoke(anon.anonymized_text)
    return proxy.deanonymize(mapping_id=anon.mapping_id, text=reply.content)


if __name__ == "__main__":
    out = privacy_safe_chat("Write a short greeting to Max Mustermann (max@whitestag.de).")
    print(out)
