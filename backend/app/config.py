"""Paths and defaults. Everything can be overridden with environment variables:

STOCKFISH_PATH  path to the Stockfish UCI executable (default engines/stockfish19.exe)
LC0_PATH        path to the lc0 executable that runs Maia (default engines/lc0/lc0.exe)
MAIA_WEIGHTS_DIR  folder with the Maia nets, maia-<rating>.pb.gz (default engines/maia)
FAIRY_PATH      path to Fairy-Stockfish, which plays the variants (default engines/fairy/fairy-stockfish.exe)
OLLAMA_URL     base URL of the Ollama server (default http://localhost:11434)
OLLAMA_MODEL    preferred explanation model (default gpt-oss:20b; falls back to the
                first installed model when it is not available)
DATA_DIR        folder with the opening JSON files (default data/openings)
FRONTEND_DIST   built frontend to serve at / (default frontend/dist)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping

ROOT_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    stockfish_path: Path = ROOT_DIR / "engines" / "stockfish19.exe"
    lc0_path: Path = ROOT_DIR / "engines" / "lc0" / "lc0.exe"
    maia_weights_dir: Path = ROOT_DIR / "engines" / "maia"
    fairy_path: Path = ROOT_DIR / "engines" / "fairy" / "fairy-stockfish.exe"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "gpt-oss:20b"
    data_dir: Path = ROOT_DIR / "data" / "openings"
    frontend_dist: Path = ROOT_DIR / "frontend" / "dist"
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")

    # engine pool
    analysis_threads: int = 4
    analysis_hash_mb: int = 512
    review_threads: int = 4
    review_hash_mb: int = 512
    bot_threads: int = 2
    bot_hash_mb: int = 128

    # Maia (lc0). One node per move, so one thread and a small cache are plenty.
    lc0_threads: int = 1
    lc0_nn_cache_size: int = 20_000
    maia_timeout_s: float = 30.0  # a Maia move slower than this means lc0 hung: it is killed

    # defaults used by the routers
    analyze_default_depth: int = 18
    analyze_default_multipv: int = 3
    review_default_depth: int = 16
    bot_default_movetime_ms: int = 800
    ws_analyze_min_interval_s: float = 0.1  # <= 10 messages per second
    ws_analyze_max_seconds: float = 300.0  # a live analysis stops by itself after this long
    book_max_ply: int = 30
    max_review_jobs: int = 50  # finished jobs kept in memory (oldest evicted first)
    warm_up_engines: bool = True  # start the analysis engine in the background at startup

    # Ollama
    ollama_timeout_s: float = 180.0  # per explanation (read timeout between streamed chunks)
    ollama_health_timeout_s: float = 2.5

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        defaults = cls()
        return cls(
            stockfish_path=Path(env.get("STOCKFISH_PATH") or defaults.stockfish_path),
            lc0_path=Path(env.get("LC0_PATH") or defaults.lc0_path),
            maia_weights_dir=Path(env.get("MAIA_WEIGHTS_DIR") or defaults.maia_weights_dir),
            fairy_path=Path(env.get("FAIRY_PATH") or defaults.fairy_path),
            ollama_url=(env.get("OLLAMA_URL") or defaults.ollama_url).rstrip("/"),
            ollama_model=env.get("OLLAMA_MODEL") or defaults.ollama_model,
            data_dir=Path(env.get("DATA_DIR") or defaults.data_dir),
            frontend_dist=Path(env.get("FRONTEND_DIST") or defaults.frontend_dist),
        )

    def with_overrides(self, **changes: object) -> "Settings":
        """Copy with some fields replaced (used by tests)."""
        return replace(self, **changes)  # type: ignore[arg-type]
