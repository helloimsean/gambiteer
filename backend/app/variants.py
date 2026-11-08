"""The chess variants the Play tab offers.

Stockfish 19 plays standard chess and Chess960. It knows none of the others, so those run on
Fairy-Stockfish, an optional separate install (``tools/install_fairy.py``). python-chess has a board
class for each one, and passing that board to the engine selects the variant (``UCI_Variant``).
"""
from __future__ import annotations

import chess
import chess.variant

from .chessutil import parse_fen, require_valid
from .config import Settings
from .engine import EngineManager

FAIRY_SLOT = "bot"
FAIRY_INSTALL_HINT = "Install it with: python tools\\install_fairy.py, then restart Gambiteer."

# Fairy-Stockfish's board class per variant. The keys are also its UCI_Variant names.
FAIRY_BOARDS: dict[str, type[chess.Board]] = {
    "crazyhouse": chess.variant.CrazyhouseBoard,
    "kingofthehill": chess.variant.KingOfTheHillBoard,
    "3check": chess.variant.ThreeCheckBoard,
    "antichess": chess.variant.AntichessBoard,
    "atomic": chess.variant.AtomicBoard,
    "horde": chess.variant.HordeBoard,
    "racingkings": chess.variant.RacingKingsBoard,
}


def needs_fairy(variant: str) -> bool:
    return variant in FAIRY_BOARDS


def parse_variant_fen(variant: str, fen: str) -> chess.Board:
    """A board of the right class for ``variant``. Raises ValueError with a readable message."""
    if variant == "standard":
        return parse_fen(fen)
    if not fen.strip():
        raise ValueError("empty FEN")
    try:
        board = chess.Board(fen.strip(), chess960=True) if variant == "chess960" else FAIRY_BOARDS[variant](fen.strip())
    except ValueError as exc:
        raise ValueError(f"invalid FEN: {exc}") from exc
    return require_valid(board)


def create_manager(settings: Settings) -> EngineManager:
    """The Fairy-Stockfish process. It starts with the first variant move, never at app startup."""
    return EngineManager(
        settings.fairy_path,
        {FAIRY_SLOT: {"Threads": settings.bot_threads, "Hash": settings.bot_hash_mb}},
        label="Fairy-Stockfish",
        path_env="FAIRY_PATH",
    )
