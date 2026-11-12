"""Guards for a server that only this device should use.

The backend listens on 127.0.0.1, so other computers cannot reach it. What still can:

* A web page open in the browser. It cannot read HTTP answers (CORS) or send JSON posts (they need
  a CORS preflight, which fails), but WebSockets have no CORS, and a DNS-rebinding page counts as
  same-origin. So the Host header must name this machine, and a WebSocket a browser opens (it sends
  an Origin header) must come from a page on this machine.
* A page that frames the app (clickjacking): X-Frame-Options and frame-ancestors forbid it.
* On Android, any other app on the phone, since apps share 127.0.0.1. With an access key set
  (GAMBITEER_ACCESS_KEY; the phone app sets one), every request must carry it, as the
  `gambiteer_key` cookie the app's WebView holds or as an `X-Gambiteer-Key` header.
"""
from __future__ import annotations

import hmac
from collections.abc import Iterable
from http.cookies import CookieError, SimpleCookie
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Message, Receive, Scope, Send

ACCESS_COOKIE = "gambiteer_key"
ACCESS_HEADER = b"x-gambiteer-key"
FRAME_HEADERS = [(b"x-frame-options", b"DENY"), (b"content-security-policy", b"frame-ancestors 'none'")]


def host_name(value: str) -> str:
    """The host of a Host header, lower case: 'localhost:8000' -> 'localhost', '[::1]:8000' -> '::1'."""
    value = value.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 0 else ""
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


class LocalGuard:
    """Pure ASGI middleware, so it covers WebSockets as well as HTTP."""

    def __init__(self, app: ASGIApp, *, allowed_hosts: Iterable[str], access_key: str | None = None) -> None:
        self.app = app
        self.allowed = {h.lower() for h in allowed_hosts}
        self.key = access_key.encode() if access_key else None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        problem = self.problem(scope["type"], headers)
        if problem:
            await self.reject(scope, receive, send, problem)
            return
        if scope["type"] == "websocket":
            await self.app(scope, receive, send)
            return

        async def send_with_frame_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), *FRAME_HEADERS]}
            await send(message)

        await self.app(scope, receive, send_with_frame_headers)

    def problem(self, kind: str, headers: dict[bytes, bytes]) -> str | None:
        """Why the request is refused, or None."""
        if host_name(headers.get(b"host", b"").decode("latin-1")) not in self.allowed:
            return "unknown host"
        origin = headers.get(b"origin")
        # Programs other than browsers send no Origin (and could fake one), so only browsers are held to it.
        if kind == "websocket" and origin is not None and urlsplit(origin.decode("latin-1")).hostname not in self.allowed:
            return "WebSocket from another site"
        if self.key is not None and not self.has_key(headers):
            return "missing access key"
        return None

    def has_key(self, headers: dict[bytes, bytes]) -> bool:
        assert self.key is not None
        given = headers.get(ACCESS_HEADER)
        if given is None:
            cookie = SimpleCookie()
            try:
                cookie.load(headers.get(b"cookie", b"").decode("latin-1"))
            except CookieError:
                return False
            morsel = cookie.get(ACCESS_COOKIE)
            given = morsel.value.encode("latin-1") if morsel else None
        return given is not None and hmac.compare_digest(given, self.key)

    async def reject(self, scope: Scope, receive: Receive, send: Send, reason: str) -> None:
        if scope["type"] == "websocket":
            # refusing the handshake makes the server answer 403
            if (await receive())["type"] == "websocket.connect":
                await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = f"Refused: {reason}".encode()
        await send(
            {
                "type": "http.response.start",
                "status": 400 if reason == "unknown host" else 403,
                "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode()), *FRAME_HEADERS],
            }
        )
        await send({"type": "http.response.body", "body": body})
