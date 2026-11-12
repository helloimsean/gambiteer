"""Runs the desktop Gambiteer backend, unchanged, inside the Android app.

Kotlin calls ``run`` on a background thread and the function only returns when the server stops.
The paths reach the backend through the same environment variables the desktop version reads, and
the only other difference is smaller engine settings for a phone (see ``PHONE_SETTINGS``).
"""
from __future__ import annotations

import os
from pathlib import Path

PHONE_SETTINGS = {
    "analysis_threads": 4,
    "analysis_hash_mb": 128,
    "review_threads": 4,
    "review_hash_mb": 128,
    "bot_threads": 2,
    "bot_hash_mb": 32,
    "warm_up_engines": False,
}


def configure_environment(native_dir: str, payload_dir: str, coach_port: int, access_key: str) -> None:
    native = Path(native_dir)
    payload = Path(payload_dir)
    os.environ.update(
        {
            "STOCKFISH_PATH": str(native / "libstockfish.so"),
            "LC0_PATH": str(native / "liblc0.so"),
            "FAIRY_PATH": str(native / "libfairy.so"),
            "MAIA_WEIGHTS_DIR": str(payload / "maia"),
            "DATA_DIR": str(payload / "openings"),
            "FRONTEND_DIST": str(payload / "web"),
            "OLLAMA_URL": f"http://127.0.0.1:{coach_port}",
            "OLLAMA_MODEL": "gemma4:e4b",
            # every request must carry it, so other apps on the phone cannot use the backend or coach
            "GAMBITEER_ACCESS_KEY": access_key,
        }
    )


def create_server(port: int):
    # Imported here so the environment above is in place before app.main builds its default app.
    import uvicorn

    from app.config import Settings
    from app.main import create_app

    settings = Settings.from_env().with_overrides(**PHONE_SETTINGS)
    config = uvicorn.Config(
        create_app(settings),
        host="127.0.0.1",
        port=port,
        loop="asyncio",
        http="h11",
        ws="websockets",
        lifespan="on",
        log_level="info",
        access_log=False,
    )
    return uvicorn.Server(config)


def run(native_dir: str, payload_dir: str, port: int, coach_port: int, access_key: str) -> None:
    configure_environment(native_dir, payload_dir, coach_port, access_key)
    create_server(port).run()
