"""GET /api/health and GET /api/ollama/models."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from ..deps import services
from ..engine import EngineUnavailable
from ..ollama_client import OllamaError
from ..schemas import HealthResponse, OllamaHealth, OllamaModelsResponse, StockfishHealth

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    """ok = Stockfish can be started (Ollama is optional: it only powers explanations)."""
    svc = services(request)
    engines = svc.engines
    stockfish_ok = False
    if engines.available:
        try:
            await engines.get("analysis")
            stockfish_ok = True
        except EngineUnavailable as exc:
            log.warning("health: %s", exc)
    try:
        ollama = OllamaHealth(ok=True, models=[m.name for m in await svc.ollama.list_models()])
    except OllamaError:
        ollama = OllamaHealth(ok=False, models=[])
    svc.openings.refresh_if_changed()
    return HealthResponse(
        ok=stockfish_ok,
        stockfish=StockfishHealth(name=engines.engine_name, path=str(engines.path)),
        ollama=ollama,
        openings=len(svc.openings),
    )


@router.get("/ollama/models", response_model=OllamaModelsResponse)
async def ollama_models(request: Request) -> OllamaModelsResponse:
    """Installed models; an empty list (default "") when Ollama is not reachable."""
    svc = services(request)
    try:
        models = await svc.ollama.list_models()
    except OllamaError as exc:
        log.warning("ollama models: %s", exc)
        return OllamaModelsResponse(models=[], default="")
    default = await svc.ollama.default_model(models) if models else ""
    return OllamaModelsResponse(models=models, default=default)
