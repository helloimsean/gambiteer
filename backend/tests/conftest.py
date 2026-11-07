"""Shared fixtures. Tests never need Ollama; engine tests skip when Stockfish is missing."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"
SETTINGS = Settings.from_env()
HAS_STOCKFISH = SETTINGS.stockfish_path.is_file()
needs_stockfish = pytest.mark.skipif(not HAS_STOCKFISH, reason=f"Stockfish not found at {SETTINGS.stockfish_path}")


def test_settings(**overrides: object) -> Settings:
    """Settings pointing at the fixture openings, with small engines and no warm-up."""
    base = SETTINGS.with_overrides(
        data_dir=FIXTURES,
        analysis_threads=2,
        analysis_hash_mb=32,
        review_threads=2,
        review_hash_mb=32,
        bot_threads=1,
        bot_hash_mb=16,
        warm_up_engines=False,
    )
    return base.with_overrides(**overrides) if overrides else base


test_settings.__test__ = False  # type: ignore[attr-defined]  # not a test function


@pytest.fixture(scope="session")
def fixture_dir() -> Path:
    return FIXTURES
