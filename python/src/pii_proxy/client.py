"""HTTP client for pii-proxy server."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import httpx


class ExternalCall(TypedDict, total=False):
    url: str
    method: Literal["POST", "PUT"]
    headers: dict[str, str]
    bodyTemplate: dict[str, Any]
    responsePath: str


@dataclass
class AnonymizeResult:
    blocked: Literal[False] = False
    anonymized_text: str = ""
    mapping_id: str = ""


@dataclass
class AnonymizeBlocked:
    blocked: Literal[True] = True
    reason: str = ""


@dataclass
class SafeCallResult:
    blocked: Literal[False] = False
    text: str = ""


@dataclass
class SafeCallBlocked:
    blocked: Literal[True] = True
    reason: str = ""


class PiiProxyError(RuntimeError):
    """Raised when the pii-proxy server returns a non-2xx response."""


class PiiProxyClient:
    """Synchronous HTTP client for the pii-proxy server."""

    def __init__(
        self,
        base_url: str,
        shared_key: str,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = shared_key
        self._timeout = timeout
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "PiiProxyClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def health(self) -> dict[str, str]:
        r = self._client.get(f"{self._base}/health")
        self._raise_for_status(r, "/health")
        return r.json()

    def anonymize(
        self,
        text: str,
        target_llm: str,
        agent: str,
        tenant_id: str | None = None,
    ) -> AnonymizeResult | AnonymizeBlocked:
        body: dict[str, Any] = {"text": text, "targetLlm": target_llm, "agent": agent}
        if tenant_id:
            body["tenantId"] = tenant_id
        data = self._post("/anonymize", body)
        if data.get("blocked"):
            return AnonymizeBlocked(blocked=True, reason=data["reason"])
        return AnonymizeResult(
            blocked=False,
            anonymized_text=data["anonymizedText"],
            mapping_id=data["mappingId"],
        )

    def deanonymize(self, mapping_id: str, text: str) -> str:
        data = self._post("/deanonymize", {"mappingId": mapping_id, "text": text})
        return data["text"]

    def safe_call(
        self,
        prompt: str,
        target_llm: str,
        agent: str,
        external: ExternalCall,
        tenant_id: str | None = None,
    ) -> SafeCallResult | SafeCallBlocked:
        body: dict[str, Any] = {
            "prompt": prompt,
            "targetLlm": target_llm,
            "agent": agent,
            "external": external,
        }
        if tenant_id:
            body["tenantId"] = tenant_id
        data = self._post("/safe-call", body)
        if data.get("blocked"):
            return SafeCallBlocked(blocked=True, reason=data["reason"])
        return SafeCallResult(blocked=False, text=data["text"])

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        r = self._client.post(
            f"{self._base}{path}",
            json=body,
            headers={"x-pii-proxy-key": self._key},
        )
        self._raise_for_status(r, path)
        return r.json()

    def _raise_for_status(self, r: httpx.Response, path: str) -> None:
        if r.is_success:
            return
        raise PiiProxyError(f"pii-proxy {path} {r.status_code}: {r.text}")
