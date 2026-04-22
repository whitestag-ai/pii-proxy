import pytest
from pytest_httpx import HTTPXMock
from pii_proxy import PiiProxyClient, PiiProxyError

KEY = "client-test-key-32-bytes-xxxxxxxxx"
BASE = "http://localhost:4711"


def make_client() -> PiiProxyClient:
    return PiiProxyClient(base_url=BASE, shared_key=KEY, timeout=5.0)


def test_anonymize_returns_mapping_and_text(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/anonymize",
        json={"blocked": False, "anonymizedText": "hi [PERSON_A]", "mappingId": "m-1"},
    )
    client = make_client()
    res = client.anonymize(text="hi Max", target_llm="gpt-4o", agent="test")
    assert res.blocked is False
    assert res.anonymized_text == "hi [PERSON_A]"
    assert res.mapping_id == "m-1"

    req = httpx_mock.get_requests()[0]
    assert req.headers["x-pii-proxy-key"] == KEY


def test_anonymize_returns_blocked(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/anonymize",
        json={"blocked": True, "reason": "art_9_data_detected"},
    )
    client = make_client()
    res = client.anonymize(text="x", target_llm="gpt-4o", agent="test")
    assert res.blocked is True
    assert res.reason == "art_9_data_detected"


def test_deanonymize_returns_text(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/deanonymize", json={"text": "hi Max"}
    )
    client = make_client()
    out = client.deanonymize(mapping_id="m-1", text="hi [PERSON_A]")
    assert out == "hi Max"


def test_safe_call_roundtrip(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/safe-call",
        json={"blocked": False, "text": "done"},
    )
    client = make_client()
    res = client.safe_call(
        prompt="hi Max",
        target_llm="gpt-4o",
        agent="test",
        external={
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {"Authorization": "Bearer t"},
            "bodyTemplate": {"content": "{{prompt}}"},
            "responsePath": "content",
        },
    )
    assert res.blocked is False
    assert res.text == "done"


def test_non_2xx_raises(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url=f"{BASE}/anonymize", status_code=401, text="nope")
    client = make_client()
    with pytest.raises(PiiProxyError, match="401"):
        client.anonymize(text="x", target_llm="y", agent="z")


def test_health_no_auth_required(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/health", json={"status": "ok", "classifier": "reachable"}
    )
    client = make_client()
    health = client.health()
    assert health["classifier"] == "reachable"
    req = httpx_mock.get_requests()[0]
    # health is unauthenticated; the client should not send the key
    assert "x-pii-proxy-key" not in {k.lower() for k in req.headers.keys()}
