"""Small python-chess helpers shared by the routers and services.

Scores leave this module as plain dicts in the API convention: ``{"cp": n}`` or ``{"mate": n}``,
always from White's point of view. A position that is already checkmate is ``{"mate": 0}``; the
mated side is the side to move in that position.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import chess
import chess.engine

from .schemas import EngineLine

PIECE_VALUES: dict[chess.PieceType, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 100,  # only used to order attackers; kings are never captured
}

PIECE_NAMES: dict[chess.PieceType, str] = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
    chess.KING: "king",
}

ScoreDict = dict[str, int]


def color_name(color: chess.Color) -> str:
    return "white" if color == chess.WHITE else "black"


def require_valid(board: chess.Board) -> chess.Board:
    """The board, if its position is legal. Invalid positions can crash engines, so ValueError otherwise."""
    status = board.status()
    if status != chess.STATUS_VALID:
        problems = [flag.name.lower() for flag in chess.Status if flag and flag in status]
        raise ValueError("illegal position: " + (", ".join(problems) or str(status)))
    return board


def parse_fen(fen: str) -> chess.Board:
    """Parse a FEN and make sure it is a position Stockfish can safely search.

    Raises ValueError with a readable message otherwise (invalid positions can crash engines).
    """
    if not isinstance(fen, str) or not fen.strip():
        raise ValueError("empty FEN")
    try:
        board = chess.Board(fen.strip())
    except ValueError as exc:
        raise ValueError(f"invalid FEN: {exc}") from exc
    return require_valid(board)


def is_standard_start(board: chess.Board) -> bool:
    """True if the board is the normal initial position (move counters ignored)."""
    start = chess.Board()
    return (
        board.board_fen() == start.board_fen()
        and board.turn == chess.WHITE
        and board.castling_rights == start.castling_rights
        and board.ep_square is None
    )


def parse_move(board: chess.Board, text: str) -> chess.Move:
    """Parse one move given as UCI ("e2e4", "e7e8q") or SAN ("e4", "O-O", "0-0").

    Castling given as king-takes-rook UCI ("e1h1", the Chess960 convention python-chess also
    accepts in standard chess) is normalized to the standard form ("e1g1"), so it compares equal
    to the same move parsed from SAN or from the engine.
    """
    token = str(text).strip()
    if not token:
        raise ValueError("empty move")
    move: chess.Move | None
    try:
        # parse_uci checks legality and maps king-takes-rook castling to e1g1 / e1c1 (standard chess)
        move = board.parse_uci(token.lower() if len(token) in (4, 5) else token)
    except ValueError:
        move = None
    if move:  # Move.null() ("0000") is falsy: never a real move here
        return move
    san = token.replace("0-0-0", "O-O-O").replace("0-0", "O-O")
    try:
        parsed = board.parse_san(san)
    except ValueError as exc:
        raise ValueError(f"illegal or unparseable move '{token}' in position {board.fen()}") from exc
    if not parsed:  # parse_san reads "--" / "0000" as a null move
        raise ValueError(f"illegal or unparseable move '{token}' in position {board.fen()}")
    return parsed


def clean_san(text: str) -> str:
    """SAN without check marks or annotations ('Nf3+!?' -> 'Nf3'; '0-0' -> 'O-O')."""
    return text.strip().rstrip("!?+#").replace("0-0-0", "O-O-O").replace("0-0", "O-O")


def parse_book_move(board: chess.Board, san: str, uci: str | None = None) -> chess.Move | None:
    """A repertoire note's move (``san`` may also be UCI, ``uci`` is optional) as a legal move in
    ``board``, or None when it is not legal there."""
    for text in (uci, clean_san(san)):
        if not text:
            continue
        try:
            return parse_move(board, text)
        except ValueError:
            continue
    return None


def score_to_dict(score: chess.engine.PovScore | chess.engine.Score, board: chess.Board | None = None) -> ScoreDict:
    """Convert a python-chess score to the White-POV API dict."""
    white = score.white() if isinstance(score, chess.engine.PovScore) else score
    mate = white.mate()
    if mate is not None:
        return {"mate": int(mate)}
    cp = white.score()
    return {"cp": int(cp if cp is not None else 0)}


def pv_to_san(board: chess.Board, moves: Iterable[chess.Move]) -> tuple[list[str], list[str]]:
    """SAN and UCI lists for a PV, stopping at the first illegal move."""
    b = board.copy(stack=False)
    sans: list[str] = []
    ucis: list[str] = []
    for move in moves:
        if move not in b.legal_moves:
            break
        sans.append(b.san(move))
        ucis.append(move.uci())
        b.push(move)
    return sans, ucis


def numbered_line(board: chess.Board, ucis: Sequence[str], max_plies: int | None = None) -> str:
    """'12...Qd6 13.Nf3 O-O' from a UCI list starting at ``board``."""
    b = board.copy(stack=False)
    parts: list[str] = []
    for i, uci in enumerate(ucis):
        if max_plies is not None and i >= max_plies:
            break
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in b.legal_moves:
            break
        san = b.san(move)
        if b.turn == chess.WHITE:
            parts.append(f"{b.fullmove_number}.{san}")
        elif i == 0:
            parts.append(f"{b.fullmove_number}...{san}")
        else:
            parts.append(san)
        b.push(move)
    return " ".join(parts)


def terminal_score(board: chess.Board) -> ScoreDict | None:
    """Score for a position without legal moves (mate 0 / stalemate 0), else None."""
    if any(board.legal_moves):
        return None
    if board.is_check():
        return {"mate": 0}
    return {"cp": 0}


def terminal_lines(board: chess.Board) -> list[EngineLine] | None:
    score = terminal_score(board)
    if score is None:
        return None
    return [EngineLine(multipv=1, score=score, depth=0, pv=[], pvUci=[])]  # type: ignore[arg-type]


def info_to_line(board: chess.Board, info: Mapping[str, Any], index: int) -> EngineLine | None:
    """EngineLine from one python-chess info dict; None if it carries no score or PV yet."""
    score = info.get("score")
    pv = info.get("pv")
    if score is None or not pv:
        return None
    sans, ucis = pv_to_san(board, pv)
    if not sans:
        return None
    return EngineLine(
        multipv=int(info.get("multipv", index)),
        score=score_to_dict(score),  # type: ignore[arg-type]
        depth=int(info.get("depth", 0) or 0),
        pv=sans,
        pvUci=ucis,
    )


def infos_to_lines(board: chess.Board, infos: Iterable[Mapping[str, Any]]) -> list[EngineLine]:
    lines: list[EngineLine] = []
    for i, info in enumerate(infos, start=1):
        line = info_to_line(board, info, i)
        if line is not None:
            lines.append(line)
    lines.sort(key=lambda ln: ln.multipv)
    return lines


def material(board: chess.Board, color: chess.Color) -> int:
    return sum(
        PIECE_VALUES[pt] * len(board.pieces(pt, color))
        for pt in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
    )


def see_gain(board: chess.Board, square: chess.Square) -> int:
    """Static exchange evaluation: material the side to move can win by capturing on ``square``.

    Uses legal moves only (so pins and check are respected) and always recaptures with the least
    valuable piece; each side may stop capturing, so the result is >= 0.
    """
    target = board.piece_at(square)
    if target is None or target.color == board.turn:
        return 0
    captures = [m for m in board.legal_moves if m.to_square == square]
    if not captures:
        return 0
    move = min(captures, key=lambda m: PIECE_VALUES[board.piece_type_at(m.from_square) or chess.PAWN])
    gain = PIECE_VALUES[target.piece_type]
    if move.promotion:
        gain += PIECE_VALUES[move.promotion] - 1
    board.push(move)
    try:
        gain -= see_gain(board, square)
    finally:
        board.pop()
    return max(0, gain)


def hanging_pieces(board: chess.Board, color: chess.Color) -> list[str]:
    """Pieces of ``color`` that are attacked and undefended, or attacked by a cheaper piece."""
    out: list[str] = []
    for square, piece in sorted(board.piece_map().items()):
        if piece.color != color or piece.piece_type == chess.KING:
            continue
        attackers = board.attackers(not color, square)
        if not attackers:
            continue
        defenders = board.attackers(color, square)
        cheapest = min(attackers, key=lambda s: PIECE_VALUES[board.piece_type_at(s) or chess.PAWN])
        cheapest_type = board.piece_type_at(cheapest) or chess.PAWN
        if not defenders or PIECE_VALUES[cheapest_type] < PIECE_VALUES[piece.piece_type]:
            out.append(
                f"{color_name(color)} {PIECE_NAMES[piece.piece_type]} on {chess.square_name(square)} "
                f"(attacked by the {PIECE_NAMES[cheapest_type]} on {chess.square_name(cheapest)}"
                f"{', undefended' if not defenders else ''})"
            )
    return out
