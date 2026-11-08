"""FastAPI app factory.

Run (cwd backend):  python -m uvicorn app.main:app --port 8000

The lifespan creates the EngineManager on the running event loop (python-chess async engines must
live on the loop that drives them) and quits every engine on shutdown. The built frontend
(frontend/dist) is served at / when it exists, with an index.html fallback for client-side paths.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .config import Settings
from .deps import Services
from .engine import EngineManager, EngineUnavailable
from .maia import create_manager as create_maia_manager
from .ollama_client import OllamaClient, OllamaError
from .openings import OpeningStore
from .review import ReviewService
from .routers import analysis, bot, coach, explain, openings, pgn, review, system
from .variants import create_manager as create_fairy_manager

log = logging.getLogger("app")


def _configure_logging() -> None:
    """Show this package's INFO logs next to uvicorn's (uvicorn only configures its own loggers)."""
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s:     [%(name)s] %(message)s"))
        log.addHandler(handler)
        log.setLevel(logging.INFO)
        log.propagate = False


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    _configure_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = OpeningStore(settings.data_dir)
        store.load()
        engines = EngineManager.from_settings(settings)
        await engines.start()  # bind to this (the running) loop
        maia = create_maia_manager(settings)  # no warm-up: lc0 starts with the first Maia move
        await maia.start()
        fairy = create_fairy_manager(settings)  # no warm-up either: it starts with the first variant move
        await fairy.start()
        ollama = OllamaClient(
            settings.ollama_url,
            settings.ollama_model,
            timeout_s=settings.ollama_timeout_s,
            health_timeout_s=settings.ollama_health_timeout_s,
        )
        reviews = ReviewService(engines, store, max_jobs=settings.max_review_jobs, book_max_ply=settings.book_max_ply)
        app.state.services = Services(settings, store, engines, ollama, reviews, maia, fairy)
        warm = asyncio.create_task(engines.warm_up("analysis")) if settings.warm_up_engines else None
        log.info(
            "backend ready: %d opening(s) from %s, stockfish %s, ollama %s",
            len(store), settings.data_dir, settings.stockfish_path, settings.ollama_url,
        )
        try:
            yield
        finally:
            if warm is not None:
                warm.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await warm
            await reviews.close()
            await engines.close()
            await maia.close()
            await fairy.close()
            await ollama.aclose()

    app = FastAPI(title="Gambiteer", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(EngineUnavailable)
    async def _engine_unavailable(_: Request, exc: EngineUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(OllamaError)
    async def _ollama_error(_: Request, exc: OllamaError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    for module in (system, openings, analysis, bot, pgn, review, explain, coach):
        app.include_router(module.router)

    dist = settings.frontend_dist

    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend(full_path: str) -> FileResponse:
        """Serve frontend/dist; unknown non-API paths get index.html (client-side routing)."""
        first = full_path.split("/", 1)[0]
        if first in ("api", "ws"):
            raise HTTPException(status_code=404, detail="Not Found")
        index = dist / "index.html"
        if not index.is_file():
            raise HTTPException(
                status_code=404,
                detail="frontend not built: run `npm run build` in frontend/ (or use the Vite dev server on :5173)",
            )
        if full_path:
            root = dist.resolve()
            candidate = (dist / full_path).resolve()
            if candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
        return FileResponse(index)

    return app


app = create_app()
