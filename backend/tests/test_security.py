"""The guards in app/security.py: other sites, DNS rebinding, framing and (on the phone) other apps."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.security import host_name

from .conftest import test_settings


@pytest.mark.parametrize(
    ("header", "host"),
    [
        ("localhost:8000", "localhost"),
        ("127.0.0.1", "127.0.0.1"),
        ("[::1]:8000", "::1"),
        ("LOCALHOST:8000", "localhost"),
        ("evil.example:8000", "evil.example"),
        ("", ""),
    ],
)
def test_host_name(header: str, host: str) -> None:
    assert host_name(header) == host


def test_allowed_hosts_from_env() -> None:
    settings = Settings.from_env({"ALLOWED_HOSTS": "chess.lan, my-pc"})
    assert settings.allowed_hosts == ("localhost", "127.0.0.1", "::1", "chess.lan", "my-pc")
    assert Settings.from_env({}).access_key is None
    assert Settings.from_env({"GAMBITEER_ACCESS_KEY": "k"}).access_key == "k"


@pytest.fixture(scope="module")
def client() -> TestClient:
    with TestClient(create_app(test_settings())) as c:
        yield c


def test_a_request_for_this_machine_is_answered(client: TestClient) -> None:
    for host in ("localhost:8000", "127.0.0.1:8000", "[::1]:8000"):
        assert client.get("/api/openings", headers={"Host": host}).status_code == 200


def test_dns_rebinding_is_refused(client: TestClient) -> None:
    res = client.get("/api/health", headers={"Host": "evil.example:8000"})
    assert res.status_code == 400
    assert "stockfish" not in res.text


def test_pages_cannot_be_framed(client: TestClient) -> None:
    res = client.get("/api/openings")
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["content-security-policy"] == "frame-ancestors 'none'"


def test_a_websocket_from_another_site_is_refused(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws/analyze", headers={"Origin": "https://evil.example"}):
            pass
    assert refused.value.code == 1008
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/coach", headers={"Origin": "null"}):  # a sandboxed or file:// page
            pass


@pytest.mark.parametrize("origin", ["http://localhost:8000", "http://127.0.0.1:8000", "http://localhost:5173", None])
def test_a_websocket_from_this_machine_is_accepted(client: TestClient, origin: str | None) -> None:
    headers = {"Origin": origin} if origin else {}
    with client.websocket_connect("/ws/analyze", headers=headers) as ws:
        ws.send_json({"stop": True})


@pytest.fixture(scope="module")
def keyed() -> TestClient:
    with TestClient(create_app(test_settings(access_key="s3cret-key"))) as c:
        yield c


def test_with_an_access_key_a_request_without_it_is_refused(keyed: TestClient) -> None:
    assert keyed.get("/api/openings").status_code == 403
    assert keyed.get("/api/openings", headers={"X-Gambiteer-Key": "wrong"}).status_code == 403
    assert keyed.get("/api/openings", headers={"Cookie": "gambiteer_key=wrong"}).status_code == 403
    assert keyed.get("/", headers={"Cookie": "other=1"}).status_code == 403


def test_the_key_works_as_a_header_or_the_webview_cookie(keyed: TestClient) -> None:
    assert keyed.get("/api/openings", headers={"X-Gambiteer-Key": "s3cret-key"}).status_code == 200
    assert keyed.get("/api/openings", headers={"Cookie": "theme=dark; gambiteer_key=s3cret-key"}).status_code == 200


def test_with_an_access_key_websockets_need_it_too(keyed: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect):
        with keyed.websocket_connect("/ws/analyze"):
            pass
    with keyed.websocket_connect("/ws/analyze", headers={"Cookie": "gambiteer_key=s3cret-key"}) as ws:
        ws.send_json({"stop": True})


def test_the_coach_client_sends_the_access_key() -> None:
    from app.ollama_client import OllamaClient

    assert OllamaClient("http://127.0.0.1:11434", "m", api_key="s3cret-key")._client.headers["authorization"] == "Bearer s3cret-key"
    assert "authorization" not in OllamaClient("http://127.0.0.1:11434", "m")._client.headers
