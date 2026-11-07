"""POST /api/pgn/parse."""
from __future__ import annotations

import io
import re

import chess
import chess.pgn
from fastapi import APIRouter, HTTPException

from ..schemas import PgnMove, PgnParseRequest, PgnParseResponse

router = APIRouter(prefix="/api/pgn", tags=["pgn"])

_SAN = re.compile(r"^(?:[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[NBRQnbrq])?|O-O(?:-O)?|0-0(?:-0)?|--|Z0)[+#]?[!?]*$")
_MOVE_NUMBER = re.compile(r"^\d+\.+")
_OTHER_TOKENS = re.compile(r"^(?:1-0|0-1|1/2-1/2|\*|\$\d+|[!?]{1,2}|\+/?[-=]|[-=]/?\+|=|\+-|-\+|∞)$")


def _strip_nested(text: str, open_ch: str, close_ch: str) -> str:
    out, depth = [], 0
    for ch in text:
        if ch == open_ch:
            depth += 1
        elif ch == close_ch and depth:
            depth -= 1
        elif not depth:
            out.append(ch)
    return "".join(out)


def unrecognised_tokens(text: str, game_end: int | None = None) -> list[str]:
    """Tokens in the first game's movetext that are neither moves, move numbers, NAGs nor results.

    python-chess silently skips text it cannot tokenize (e.g. "Kf9"), which would cut a pasted game
    short without telling the user, so the router rejects such PGNs instead.
    """
    body_lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and body_lines:
            break  # the next game's headers
        if stripped.startswith(("[", "%")):
            continue
        body_lines.append(line.split(";", 1)[0])
    body = _strip_nested(" ".join(body_lines), "{", "}")
    body = _strip_nested(body, "(", ")")
    bad = []
    for token in body.split():
        token = _MOVE_NUMBER.sub("", token)
        if not token or _SAN.match(token) or _OTHER_TOKENS.match(token):
            continue
        bad.append(token)
    return bad


def parse_pgn(text: str) -> PgnParseResponse:
    """Parse the first game of a PGN (headers optional). Raises ValueError on bad input."""
    if not text or not text.strip():
        raise ValueError("empty PGN")
    game = chess.pgn.read_game(io.StringIO(text))
    if game is None:
        raise ValueError("no game found in PGN")
    if game.errors:
        raise ValueError("; ".join(str(e) for e in game.errors[:3]))
    bad = unrecognised_tokens(text)
    if bad:
        raise ValueError("unrecognised move text: " + " ".join(bad[:5]))
    board = game.board()
    start_fen = board.fen()
    moves: list[PgnMove] = []
    for move in game.mainline_moves():
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {move.uci()} at ply {len(moves) + 1}")
        san = board.san(move)
        board.push(move)
        moves.append(PgnMove(san=san, uci=move.uci(), fen=board.fen()))
    headers = {k: v for k, v in game.headers.items()}
    if not moves and not text.lstrip().startswith("["):
        # read_game returns an empty game for text that is neither headers nor moves
        raise ValueError("no moves found in PGN")
    return PgnParseResponse(headers=headers, moves=moves, startFen=start_fen)


@router.post("/parse", response_model=PgnParseResponse)
async def parse(req: PgnParseRequest) -> PgnParseResponse:
    try:
        return parse_pgn(req.pgn)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"bad PGN: {exc}") from exc
