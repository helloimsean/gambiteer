"""Access to the per-app services created in the FastAPI lifespan (stored on ``app.state``)."""
from __future__ import annotations

from dataclasses import dataclass

from starlette.requests import HTTPConnection

from .config import Settings
from .engine import EngineManager
from .ollama_client import OllamaClient
from .openings import OpeningStore
from .review import ReviewService


@dataclass
class Services:
    settings: Settings
    openings: OpeningStore
    engines: EngineManager
    ollama: OllamaClient
    reviews: ReviewService
    maia: EngineManager  # lc0, started by the first Maia move
    fairy: EngineManager  # Fairy-Stockfish, started by the first variant move


def services(conn: HTTPConnection) -> Services:
    """Works for both HTTP requests and WebSockets."""
    return conn.app.state.services
