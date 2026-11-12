"""Ollama HTTP client (httpx) and the explanation prompt builders.

The prompts are built only from engine data and facts computed with python-chess (material, pieces
left hanging, check, castling rights), so the model has no reason to invent the position.
``build_explain_messages`` explains a reviewed move; ``build_coach_messages`` explains a practice
move from the Learn tab with the same facts plus the repertoire context (shared ``_fact_sheet``).
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any

import chess
import httpx

from .chessutil import (
    PIECE_NAMES,
    PIECE_VALUES,
    clean_san,
    color_name,
    hanging_pieces,
    material,
    numbered_line,
    parse_book_move,
)
from .review import MoveFacts, classify, is_sacrifice, mover_cp, mover_win_pct
from .schemas import BestMove, BookMoveNote, CoachContext, CoachMove, OllamaModel, ReviewMove

log = logging.getLogger(__name__)

CHAT_OPTIONS: dict[str, Any] = {"num_ctx": 4096, "temperature": 0.3, "num_predict": 220}
# gpt-oss always reasons before answering and its reasoning tokens count against num_predict, so it
# gets some headroom for the "low" reasoning pass (usually a few dozen tokens) so the visible answer
# is never cut off; the answer itself is still asked to be 2-4 sentences.
GPT_OSS_EXTRA_PREDICT = 300

CLASSIFICATION_PHRASES = {
    "brilliant": "a brilliant move",
    "great": "a great move",
    "best": "the best move",
    "excellent": "an excellent move",
    "good": "a good move",
    "book": "a book move",
    "inaccuracy": "an inaccuracy",
    "mistake": "a mistake",
    "blunder": "a blunder",
    "miss": "a missed opportunity",
}


class OllamaError(RuntimeError):
    """Ollama is unreachable, the model is missing, or generation failed."""


def is_gpt_oss(model: str) -> bool:
    return model.lower().startswith("gpt-oss")


def chat_options(model: str) -> dict[str, Any]:
    opts = dict(CHAT_OPTIONS)
    if is_gpt_oss(model):
        opts["num_predict"] = CHAT_OPTIONS["num_predict"] + GPT_OSS_EXTRA_PREDICT
    return opts


def _same_model(a: str, b: str) -> bool:
    def norm(name: str) -> str:
        return name if ":" in name else f"{name}:latest"

    return norm(a) == norm(b)


def resolve_model(requested: str | None, installed: Sequence[str], preferred: str) -> str:
    """Pick the model to use: the requested one (must be installed), else ``preferred`` when
    installed, else the first installed model."""
    if not installed:
        raise OllamaError("no Ollama models are installed (try: ollama pull llama3.2:3b)")
    if requested:
        for name in installed:
            if _same_model(name, requested):
                return name
        raise OllamaError(f"model '{requested}' is not installed in Ollama")
    for name in installed:
        if _same_model(name, preferred):
            return name
    return installed[0]


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        preferred_model: str,
        *,
        timeout_s: float = 180.0,
        health_timeout_s: float = 2.5,
        api_key: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.preferred_model = preferred_model
        self._timeout = httpx.Timeout(connect=5.0, read=timeout_s, write=10.0, pool=5.0)
        self._health_timeout = health_timeout_s
        # the phone's coach server wants the app's access key; Ollama ignores the header
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout, headers=headers)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def list_models(self, *, timeout: float | None = None) -> list[OllamaModel]:
        try:
            resp = await self._client.get("/api/tags", timeout=timeout or self._health_timeout)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaError(f"Ollama not reachable at {self.base_url}: {type(exc).__name__}: {exc}") from exc
        models: list[OllamaModel] = []
        for entry in data.get("models") or []:
            details = entry.get("details") or {}
            models.append(
                OllamaModel(
                    name=str(entry.get("name") or entry.get("model") or ""),
                    size=int(entry.get("size") or 0),
                    family=str(details.get("family") or ""),
                    parameter_size=str(details.get("parameter_size") or ""),
                )
            )
        return [m for m in models if m.name]

    async def default_model(self, models: Sequence[OllamaModel] | None = None) -> str:
        if models is None:
            models = await self.list_models()
        return resolve_model(None, [m.name for m in models], self.preferred_model)

    async def resolve(self, requested: str | None) -> str:
        models = await self.list_models()
        return resolve_model(requested, [m.name for m in models], self.preferred_model)

    async def chat_stream(self, model: str, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        """Yield content tokens from /api/chat (reasoning tokens of thinking models are dropped)."""
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "options": chat_options(model),
        }
        if is_gpt_oss(model):
            payload["think"] = "low"
        try:
            async with self._client.stream("POST", "/api/chat", json=payload) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    try:
                        detail = json.loads(body).get("error") or body
                    except ValueError:
                        detail = body
                    raise OllamaError(f"Ollama /api/chat returned {resp.status_code}: {detail}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    if chunk.get("error"):
                        raise OllamaError(str(chunk["error"]))
                    text = (chunk.get("message") or {}).get("content") or ""
                    if text:
                        yield text
                    if chunk.get("done"):
                        break
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama request failed: {type(exc).__name__}: {exc}") from exc

    async def chat(self, model: str, messages: list[dict[str, str]]) -> str:
        parts = [tok async for tok in self.chat_stream(model, messages)]
        return "".join(parts).strip()


# ============================================================================ prompt


def _pawns_for_mover(
    score: dict[str, int], mover: chess.Color, side_to_move: chess.Color, who: str | None = None
) -> str:
    """'+0.35 pawns', '-2.10 pawns', or a mate phrase about the mover.

    With ``who`` None the mate phrases address the mover as "you" ('forced mate in 3 for you');
    otherwise they name the mover ('forced mate in 3 for White').
    """
    if "mate" in score:
        n = score["mate"]
        if n == 0:
            if who is None:
                return "checkmate on the board (the game is over, you won)" if side_to_move != mover else "you are checkmated"
            return f"checkmate on the board (the game is over, {who} won)" if side_to_move != mover else f"{who} is checkmated"
        mover_mates = (n > 0) == (mover == chess.WHITE)
        if who is None:
            return f"forced mate in {abs(n)} for you" if mover_mates else f"you get mated in {abs(n)}"
        return f"forced mate in {abs(n)} for {who}" if mover_mates else f"{who} gets mated in {abs(n)}"
    cp = score.get("cp", 0)
    cp = cp if mover == chess.WHITE else -cp
    return f"{cp / 100:+.2f} pawns"


def _castling_lost(before: chess.Board, after: chess.Board, mover: chess.Color) -> str:
    lost = []
    if before.has_kingside_castling_rights(mover) and not after.has_kingside_castling_rights(mover):
        lost.append("kingside")
    if before.has_queenside_castling_rights(mover) and not after.has_queenside_castling_rights(mover):
        lost.append("queenside")
    return " and ".join(lost) + " castling" if lost else "none"


def _move_number(board: chess.Board) -> str:
    """'8.' when White is to move in ``board``, '7...' when Black is."""
    return f"{board.fullmove_number}." if board.turn == chess.WHITE else f"{board.fullmove_number}..."


def _draw_on_board(board: chess.Board) -> str:
    """'stalemate' / 'insufficient material' when ``board`` is a draw by the rules, else ''."""
    if board.is_stalemate():
        return "stalemate"
    if board.is_insufficient_material():
        return "insufficient material"
    return ""


@dataclass(frozen=True)
class _FactSheet:
    """Engine and python-chess facts about one move, shared by the review and coach prompts."""

    before: chess.Board
    after: chess.Board
    mover: chess.Color
    side: str  # "White" / "Black": the side that moved
    opponent: str
    number: str  # "8." / "7..."
    move_line: str  # "Move played: 8.Bh6 (ply 15)."
    engine: list[str]  # evals, best line, continuation, material, hanging pieces, check, castling
    end: chess.Board  # the position at the end of the expected continuation (see _settled_continuation)


CONTINUATION_PLIES = 5
CONTINUATION_MAX_PLIES = 12


def _settled_continuation(after: chess.Board, ucis: Sequence[str]) -> tuple[chess.Board, int]:
    """Play the expected continuation for at least CONTINUATION_PLIES plies, then keep going
    while the line is still mid-exchange (the side to move is in check, or the next move is a
    capture), up to CONTINUATION_MAX_PLIES. Counting material at a fixed cut can stop between
    a capture and its recapture and report a piece won that is about to be taken back."""
    end = after.copy(stack=False)
    played = 0
    for move_uci in ucis[:CONTINUATION_MAX_PLIES]:
        move = chess.Move.from_uci(move_uci)
        if played >= CONTINUATION_PLIES and not end.is_check() and not end.is_capture(move):
            break
        end.push(move)
        played += 1
    return end, played


def _fact_sheet(
    *,
    fen_before: str,
    fen_after: str,
    san: str,
    uci: str,
    ply: int,
    eval_before: dict[str, int],
    eval_after: dict[str, int],
    best_move: BestMove,
    played_pv: Sequence[str],
    name_mover: bool = False,
    number_best: bool = False,
) -> _FactSheet:
    """Facts from the mover's point of view. ``name_mover`` makes mate phrases name the mover
    instead of addressing them as "you" (the coach may be talking to the other side);
    ``number_best`` writes the engine's best move with its move number and side ('6.N5f3 for
    White'), so it is not mistaken for the other side's reply."""
    before = chess.Board(fen_before)
    after = chess.Board(fen_after)
    mover = before.turn
    side = color_name(mover).capitalize()
    opponent = color_name(not mover).capitalize()
    number = _move_number(before)
    who = side if name_mover else None

    best_line = numbered_line(before, _pv_ucis(before, best_move.pv) or [best_move.uci], 5)
    played_ucis = _pv_ucis(after, played_pv)
    end, cut = _settled_continuation(after, played_ucis)
    played_line = numbered_line(after, played_ucis, cut)

    material_now = _material_text(after)
    material_later = _material_text(end)

    own_hanging = hanging_pieces(after, mover)
    their_hanging = hanging_pieces(after, not mover)
    if after.is_checkmate():
        check = "the move is checkmate"
    elif after.is_check():
        check = f"the move gives check to the {opponent} king"
    else:
        check = "no check"

    best_text = (
        f"Engine's best move for {side} in this position (instead of the played move): {number}{best_move.san}"
        if number_best
        else f"Engine's best move in this position: {best_move.san}"
    )
    engine = [
        f"Engine evaluation before the move (with best play), from {side}'s point of view: "
        f"{_pawns_for_mover(eval_before, mover, mover, who)}.",
        f"Engine evaluation after the move, from {side}'s point of view: "
        f"{_pawns_for_mover(eval_after, mover, after.turn, who)}.",
        f"{best_text}{_capture_note(before, best_move.uci)}" + (f" (best line: {best_line})." if best_line else "."),
        "Expected continuation after the played move: " + (played_line or "none (game over)") + ".",
        f"Material after the move: {material_now}; at the end of the expected continuation: {material_later}.",
        f"{side}'s pieces left hanging after the move: " + ("; ".join(own_hanging) or "none") + ".",
        f"{opponent}'s pieces hanging after the move: " + ("; ".join(their_hanging) or "none") + ".",
        f"Check: {check}. Castling rights {side} lost with this move: {_castling_lost(before, after, mover)}.",
    ]
    draw = _draw_on_board(after)
    if draw == "stalemate":
        engine.append(
            f"Game over: the move is STALEMATE ({opponent} has no legal move and is not in check), "
            "so the game ends immediately in a draw."
        )
    elif draw:
        engine.append(f"Game over: the game is drawn by {draw}.")
    return _FactSheet(
        before=before,
        after=after,
        mover=mover,
        side=side,
        opponent=opponent,
        number=number,
        move_line=f"Move played: {number}{san}{_capture_note(before, uci)} (ply {ply}).",
        engine=engine,
        end=end,
    )


def build_explain_messages(move: ReviewMove, opening_name: str | None = None) -> list[dict[str, str]]:
    """System + user messages for one reviewed move."""
    sheet = _fact_sheet(
        fen_before=move.fenBefore,
        fen_after=move.fenAfter,
        san=move.san,
        uci=move.uci,
        ply=move.ply,
        eval_before=move.evalBefore.model_dump(),
        eval_after=move.evalAfter.model_dump(),
        best_move=move.bestMove,
        played_pv=move.playedPv,
    )
    side, opponent, number = sheet.side, sheet.opponent, sheet.number
    phrase = CLASSIFICATION_PHRASES.get(move.classification, move.classification)

    facts = [
        f"Side that moved: {side} (you are coaching {side}).",
        sheet.move_line,
        f"Classification: {move.classification}.",
        *sheet.engine,
    ]
    if move.classification == "miss":
        facts.append(
            f"{opponent}'s previous move was a mistake that gave {side} a big chance; "
            f"the engine's move {move.bestMove.san} would have taken advantage of it, the played move did not."
        )
    if move.classification == "book" or move.bookWhy:
        name = move.bookOpening or opening_name or "the repertoire"
        facts.append(f"Opening theory ({name}): {move.bookWhy or 'this is a known book move.'}")

    system = (
        "You are a chess coach. Explain in 2-4 short sentences, plain language, for a club player, "
        f"why this move is {phrase}. Only refer to the moves and facts given; do not invent moves. "
        "If the move was best, say what it achieves; otherwise say what the engine's move achieves instead."
    )
    user = "Facts about the move:\n- " + "\n- ".join(facts) + f"\n\nExplain why {number}{move.san} is {phrase}."
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# ---------------------------------------------------------------------------- coach prompt

# What the engine thinks of a move, ignoring opening theory (keyed by the review classification).
ENGINE_VERDICTS = {
    "brilliant": "a brilliant move, the engine's top choice even though it gives up material",
    "great": "a strong move, the engine's top choice",
    "best": "a strong move, the engine's top choice",
    "excellent": "a good move, almost as good as the engine's top choice",
    "good": "a decent move, a little below the engine's top choice",
    "inaccuracy": "an inaccuracy, a slightly weak move",
    "mistake": "a mistake, a bad move",
    "blunder": "a blunder, a very bad move",
    "miss": "a missed opportunity",
}
TOP_LABELS = {"brilliant", "great", "best"}
SOUND_LABELS = {"excellent", "good"}
SAME_AS_BOOK_WIN_PCT = 5.0  # an off-book move within this many win% of the repertoire move is "about as good"


def engine_label(move: CoachMove) -> str:
    """The review classification of ``move`` ignoring opening theory (book moves get the label the
    engine alone would give; without the second engine line "great" reads as "best")."""
    if move.classification != "book":
        return move.classification
    before = chess.Board(move.fenBefore)
    mover = before.turn
    after_turn = not mover
    played = chess.Move.from_uci(move.uci)
    is_best = move.uci == move.bestMove.uci
    return classify(
        MoveFacts(
            played_is_best=is_best,
            drop=move.winPctBefore - move.winPctAfter,
            win_before=move.winPctBefore,
            cp_before=mover_cp(move.evalBefore, mover, mover),
            cp_after=mover_cp(move.evalAfter, mover, after_turn),
            sacrifice=is_best and played in before.legal_moves and is_sacrifice(before, played),
        )
    )


def _note_move(board: chess.Board, note: BookMoveNote) -> chess.Move | None:
    return parse_book_move(board, note.san, note.uci)


def _note_san(board: chess.Board, note: BookMoveNote) -> str:
    """The note's move as SAN in ``board``, else its text as given."""
    move = _note_move(board, note)
    return board.san(move) if move is not None else note.san.strip()


def _note_text(board: chess.Board, note: BookMoveNote) -> str:
    """'3.Bc4 (note: ...)' with the move number of the side to move in ``board`` (and what it
    captures, if anything)."""
    move = _note_move(board, note)
    san = f"{_move_number(board)}{_note_san(board, note)}" + (_capture_note(board, move.uci()) if move else "")
    why = note.why.strip()
    return f"{san} (note: {why})" if why else f"{san} (no note)"


def _matching_note(board: chess.Board, notes: Sequence[BookMoveNote], move: CoachMove) -> BookMoveNote | None:
    for note in notes:
        if note.uci == move.uci or clean_san(note.san) in (clean_san(move.san), move.uci):
            return note
        if _note_san(board, note) == move.san:
            return note
    return None


def _plain_eval(score: dict[str, int], board: chess.Board | None) -> str:
    """A White-POV score in words: 'about equal', 'slightly better for White', 'winning for Black'...
    ``board`` (the position the score belongs to, when known) names checkmate and drawn positions."""
    draw = _draw_on_board(board) if board is not None else ""
    if draw:
        return f"a draw by {draw} (the game is over)"
    if "mate" in score:
        n = score["mate"]
        if n == 0:
            winner = "White" if board is not None and board.turn == chess.BLACK else "Black"
            return f"checkmate ({winner} has won)" if board is not None else "checkmate"
        return f"a forced mate for {'White' if n > 0 else 'Black'}"
    cp = score.get("cp", 0)
    side = "White" if cp > 0 else "Black"
    size = abs(cp)
    if size < 50:
        return "about equal"
    if size < 150:
        return f"slightly better for {side}"
    if size < 300:
        return f"clearly better for {side}"
    return f"winning for {side}"


def _by_file(square: chess.Square) -> tuple[int, int]:
    return chess.square_file(square), chess.square_rank(square)


def _piece_list(board: chess.Board) -> str:
    """Where every piece stands: 'White: Ke1, Qd1, Bc1 (dark-squared), Bc4 (light-squared), Nf3,
    pawns a2 b2 ...; Black: ...' (bishops carry their square colour)."""
    parts = []
    for color in (chess.WHITE, chess.BLACK):
        items: list[str] = []
        for piece_type in (chess.KING, chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT):
            for sq in sorted(board.pieces(piece_type, color), key=_by_file):
                name = chess.piece_symbol(piece_type).upper() + chess.square_name(sq)
                if piece_type == chess.BISHOP:
                    name += " (light-squared)" if chess.BB_SQUARES[sq] & chess.BB_LIGHT_SQUARES else " (dark-squared)"
                items.append(name)
        pawns = sorted(board.pieces(chess.PAWN, color), key=_by_file)
        items.append("pawns " + " ".join(chess.square_name(sq) for sq in pawns) if pawns else "no pawns")
        parts.append(f"{color_name(color).capitalize()}: " + ", ".join(items))
    return "; ".join(parts)


def _count(n: int, name: str) -> str:
    return f"a {name}" if n == 1 else f"{n} {name}s"


def _and_join(items: Sequence[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _material_change(before: chess.Board, end: chess.Board, color: chess.Color) -> str:
    """What ``color`` gains or loses between ``before`` and ``end``, in words, with the net in
    points: 'White gives up a knight for a pawn (net -2 points for White)'. Even trades cancel."""
    side = color_name(color).capitalize()
    lost: list[str] = []
    won: list[str] = []
    net = 0
    for piece_type in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN):
        own = len(before.pieces(piece_type, color)) - len(end.pieces(piece_type, color))
        their = len(before.pieces(piece_type, not color)) - len(end.pieces(piece_type, not color))
        diff = own - their  # how many more of this piece type ``color`` lost
        net -= diff * PIECE_VALUES[piece_type]
        if diff > 0:
            lost.append(_count(diff, PIECE_NAMES[piece_type]))
        elif diff < 0:
            won.append(_count(-diff, PIECE_NAMES[piece_type]))
    if not lost and not won:
        return f"no net material change for {side} (any captures are even trades)"
    points = f"net {net:+d} point{'s' if abs(net) != 1 else ''} for {side}"
    if lost and won:
        return f"{side} gives up {_and_join(lost)} for {_and_join(won)} ({points})"
    if lost:
        return f"{side} loses {_and_join(lost)} ({points})"
    return f"{side} wins {_and_join(won)} ({points})"


BAD_NAGS = {"?", "??", "?!"}


def _repertoire_marks_bad(note: BookMoveNote | None) -> str:
    """The note's annotation when the repertoire itself marks the move as bad ('?', '??', '?!'),
    else '' (trap lines show such moves as what not to play)."""
    nag = (note.nag or "").strip() if note else ""
    return nag if nag in BAD_NAGS else ""


def _book_comparison(drop_vs_ref: float, played: str, ref: str) -> str:
    """Verdict sentence for an off-book move from its win% drop compared with ``ref``."""
    if drop_vs_ref <= -SAME_AS_BOOK_WIN_PCT:
        return (
            f"{played} is not the repertoire move, but the engine rates it better than {ref} "
            f"({int(-drop_vs_ref)} win% better), so it is a good alternative"
        )
    if drop_vs_ref < SAME_AS_BOOK_WIN_PCT:
        return (
            f"{played} is about as good as {ref} according to the engine, so it is playable, "
            "but it is not the repertoire move"
        )
    if drop_vs_ref < 10:
        return f"{played} is slightly worse than {ref} ({int(drop_vs_ref)} win% worse): an inaccuracy"
    if drop_vs_ref < 20:
        return f"{played} is clearly worse than {ref} ({int(drop_vs_ref)} win% worse): a mistake"
    return f"{played} is much worse than {ref} ({int(drop_vs_ref)} win% worse): a blunder"


def build_coach_messages(
    move: CoachMove,
    context: CoachContext | None = None,
    *,
    book_eval: dict[str, int] | None = None,
) -> list[dict[str, str]]:
    """System + user messages for one practice move (Learn tab).

    Facts are the same as for a reviewed move (``_fact_sheet``) plus the training context:

    * the student's repertoire move: why it is good, building on its repertoire note. When the
      engine calls it a mistake or blunder: honestly what goes wrong if the repertoire itself
      marks the move as bad (NAG "?", "??", "?!": the trap a line warns about), otherwise the
      engine's objection in one sentence and then the repertoire's idea (a gambit's compensation);
    * the student's off-book move: good or bad compared with the repertoire move (``book_eval`` is
      the White-POV score after that move, when known), honestly "about as good" when the engine
      rates it within 5 win% of it;
    * the opponent's move: is it good or bad, and what the student should play next.
    """
    before = chess.Board(move.fenBefore)
    mover = before.turn
    ply = (before.fullmove_number - 1) * 2 + (1 if mover == chess.WHITE else 2)
    sheet = _fact_sheet(
        fen_before=move.fenBefore,
        fen_after=move.fenAfter,
        san=move.san,
        uci=move.uci,
        ply=ply,
        eval_before=move.evalBefore.model_dump(),
        eval_after=move.evalAfter.model_dump(),
        best_move=move.bestMove,
        played_pv=move.playedPv,
        name_mover=True,
        number_best=True,
    )
    after = sheet.after
    side = sheet.side
    student_side = context.studentSide if context and context.studentSide else color_name(mover)
    student = student_side.capitalize()
    student_color = chess.WHITE if student_side == "white" else chess.BLACK
    is_student = student_side == color_name(mover)
    played = f"{sheet.number}{move.san}"
    best = f"{sheet.number}{move.bestMove.san}"
    label = engine_label(move)
    verdict = ENGINE_VERDICTS.get(label, label)
    drop = move.winPctBefore - move.winPctAfter
    notes = list(context.bookMoves) if context else []
    replies = list(context.replyBookMoves) if context else []

    facts: list[str] = []
    if context and (context.openingName or context.lineName):
        where = context.openingName or "the repertoire"
        facts.append(f"Opening: {where}" + (f", line: {context.lineName}" if context.lineName else "") + ".")
    facts.append(f"The student plays {student}.")
    who_moved = "the student" if is_student else "the student's opponent"
    facts.append(f"Side that moved: {side} ({who_moved}).")
    facts.append(sheet.move_line)
    facts.append(f"Engine rating of the move (ignoring opening theory): {label} ({verdict}).")
    facts.extend(sheet.engine)
    facts.append(f"In plain words, after the move the position is {_plain_eval(move.evalAfter.model_dump(), after)}.")
    facts.append(f"Pieces on the board after the move: {_piece_list(after)}.")
    if move.playedPv:
        facts.append(
            "Material result of the move and the expected continuation: "
            f"{_material_change(before, sheet.end, student_color)}."
        )
    else:
        facts.append(f"Material result of the move: {_material_change(before, after, student_color)}.")

    if is_student and move.inBook:
        note = _matching_note(before, notes, move)
        why = note.why.strip() if note and note.why.strip() else "none given"
        marked_bad = _repertoire_marks_bad(note)
        facts.append(f"Repertoire: {played} is the student's repertoire move here. Repertoire note: {why}")
        if label in TOP_LABELS:
            facts.append("The engine agrees: it is also the engine's top choice.")
        elif label in SOUND_LABELS:
            facts.append(f"The engine's top choice is {best}, but it rates {played} almost as good.")
        else:
            facts.append(
                f"The engine is critical: it prefers {best} and rates {played} {int(drop)} win% lower: {verdict}."
            )
        if label in TOP_LABELS or label in SOUND_LABELS:
            task = f"Explain why {played} is a good repertoire move for {student}, building on the repertoire note."
        elif label == "inaccuracy":
            task = (
                f"Explain why {played} is a good repertoire move for {student}, building on the repertoire note. "
                f"Also say honestly, in one short clause, that the engine prefers {best}."
            )
        elif marked_bad:  # the line shows a mistake on purpose (a trap the student must know): be honest
            facts.append(
                f"The repertoire itself marks {played} with \"{marked_bad}\": this line shows it as a mistake to "
                "avoid (the trap the line warns about)."
            )
            task = (
                f"Explain honestly what goes wrong with {played}, using the reason given in the repertoire note, "
                f"and that {best} was the better move."
            )
        else:  # a deliberate repertoire choice the engine dislikes (a gambit or sacrifice)
            nag_text = f" (the repertoire marks it \"{note.nag.strip()}\")" if note and note.nag and note.nag.strip() else ""
            facts.append(
                f"The repertoire plays {played} on purpose{nag_text}: the note explains the idea behind it "
                f"(for a gambit or a sacrifice, what {student} gets in return for the material)."
            )
            task = (
                f"First say honestly, in one short sentence, that the engine rates {played} as {verdict} and "
                f"prefers {best}. Then explain the idea behind {played} for {student} using the repertoire note "
                "(for a gambit or a sacrifice: what the student gets in return). Follow the note's own judgement "
                "of the move."
            )
    elif is_student and notes:
        book = move.bookMove or notes[0]
        book_text = _note_text(before, book)
        book_san = f"{sheet.number}{_note_san(before, book)}"
        facts.append(f"The played move {played} is NOT the repertoire move.")
        facts.append(f"Repertoire move here: {book_text}.")
        others = [n for n in notes if _note_san(before, n) != _note_san(before, book)][:2]
        if others:
            facts.append("Other repertoire moves here: " + "; ".join(_note_text(before, n) for n in others) + ".")
        book_move = _note_move(before, book)
        compared = True
        if book_eval is not None:
            facts.append(
                f"Engine evaluation after the repertoire move {book_san}, from {side}'s point of view: "
                f"{_pawns_for_mover(book_eval, mover, not mover, side)} "
                f"(in plain words: {_plain_eval(book_eval, None)})."
            )
            win_book = mover_win_pct(book_eval, mover, not mover)
            comparison = _book_comparison(win_book - move.winPctAfter, played, f"the repertoire move {book_san}")
        elif book_move is not None and book_move.uci() == move.bestMove.uci:
            comparison = _book_comparison(drop, played, f"the repertoire move {book_san}")
        else:  # no evaluation of the repertoire move: compare with the engine's best instead
            compared = False
            comparison = _book_comparison(drop, played, f"the engine's best move {best}")
        facts.append(f"Verdict: {comparison}.")
        if compared:
            task = (
                f"Tell the student clearly whether {played} is good or bad compared with the repertoire move "
                f"{book_san}, exactly as the verdict says, and explain what {book_san} achieves using its note."
            )
        else:
            task = (
                f"Tell the student clearly whether {played} is good or bad, exactly as the verdict says, then say "
                f"that the repertoire move is {book_san} and explain what it achieves using its note."
            )
    elif is_student:
        phrase = CLASSIFICATION_PHRASES.get(move.classification, move.classification)
        facts.append(f"Classification: {move.classification}.")
        if context is not None:
            facts.append("This position is outside the student's repertoire.")
        task = (
            f"Explain why {played} is {phrase}. If it was not the engine's best move, "
            f"say what {best} achieves instead."
        )
    else:
        facts.append(
            f"Evaluation after the move from the student's ({student}'s) point of view: "
            f"{_pawns_for_mover(move.evalAfter.model_dump(), not mover, after.turn, student)}."
        )
        if move.inBook:
            note = _matching_note(before, notes, move)
            why = note.why.strip() if note and note.why.strip() else "none given"
            facts.append(
                f"Repertoire: {played} is one of the opponent moves covered in the student's repertoire. "
                f"Note on it: {why}"
            )
        elif notes:
            facts.append(
                "The opponent left the repertoire; the opponent moves covered here were: "
                + "; ".join(_note_text(before, n) for n in notes[:3])
                + "."
            )
        facts.append(f"Verdict on {side}'s move: {verdict}.")
        reply = ""
        reply_note = False
        reply_bad = ""
        engine_reply = ""
        if replies:
            reply_note = True
            reply = f"{_move_number(after)}{_note_san(after, replies[0])}"
            facts.append(f"The student's repertoire reply: {_note_text(after, replies[0])}.")
            reply_bad = _repertoire_marks_bad(replies[0])
            if reply_bad:
                facts.append(
                    f"The repertoire itself marks the reply {reply} with \"{reply_bad}\": this line shows it as a "
                    "mistake to avoid (the trap the line warns about), not as a move to copy."
                )
            more = replies[1:3]
            if more:
                facts.append("Other repertoire replies: " + "; ".join(_note_text(after, n) for n in more) + ".")
            if move.playedPv and move.playedPv[0] != _note_san(after, replies[0]):
                engine_reply = f"{_move_number(after)}{move.playedPv[0]}"
                facts.append(f"The engine's best reply for {student} is {engine_reply}.")
        elif move.playedPv:
            reply = f"{_move_number(after)}{move.playedPv[0]}"
            reply_ucis = _pv_ucis(after, move.playedPv[:1])
            capture = _capture_note(after, reply_ucis[0]) if reply_ucis else ""
            facts.append(
                f"No repertoire reply is given here; the engine's best reply for {student} is {reply}{capture}."
            )
        else:
            facts.append("The game is over after this move.")
        task = (
            f"Talk to the student ({student}) about the opponent's move. Start with \"Your opponent's {played} is\" "
            f"and say whether it is good or bad (verdict: {verdict}) and why"
        )
        if reply_bad:
            task += (
                f", then warn the student that answering with {reply} is a mistake, using its note"
                + (f", and that {engine_reply} is the engine's choice." if engine_reply else ".")
            )
        elif reply_note:
            task += (
                f", then tell the student to answer with {reply} and why, using its note (if the note says {reply} "
                "is a mistake or a blunder, warn the student about it instead of recommending it)."
            )
        elif reply:
            task += f", then tell the student to answer with {reply} and why."
        else:
            task += "."

    draw = _draw_on_board(after)
    if draw:  # the facts say so, but models tend to skip it: the task must ask for it
        task += f" Say plainly that {played} ends the game at once in a draw by {draw}."

    system = (
        f"You are a chess coach training a student who plays {student}"
        + (f" in the {context.openingName}" if context and context.openingName else "")
        + ". Answer in 2-4 short sentences of plain language for a club player, speaking to the student "
        "as \"you\". Use only the moves and facts given; never invent moves, variations or threats. Your "
        "judgement must match the engine evaluations and the verdict in the facts: never call a bad move "
        "good or a good move bad. The piece list says exactly where every piece stands: mention only pieces "
        "and squares that match it, and name no pin, threat, check or material gain the facts do not state. "
        "Quote the material result exactly as the facts give it. When a repertoire note gives the reason for "
        "a move, explain it with the note's reason."
    )
    if not is_student:
        system += (
            f" The move in the facts was played by the student's opponent ({side}), not by the student: "
            f"the student plays {student}."
        )
    user = "Facts about the move:\n- " + "\n- ".join(facts) + f"\n\nTask: {task} Answer in 2-4 short sentences."
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _capture_note(board: chess.Board, uci: str) -> str:
    """' (captures the white queen on e5)' for a capture, else ''."""
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        return ""
    if move not in board.legal_moves or not board.is_capture(move):
        return ""
    if board.is_en_passant(move):
        return " (captures a pawn en passant)"
    victim = board.piece_at(move.to_square)
    if victim is None:
        return ""
    return f" (captures the {color_name(victim.color)} {PIECE_NAMES[victim.piece_type]} on {chess.square_name(move.to_square)})"


def _material_text(board: chess.Board) -> str:
    white, black = material(board, chess.WHITE), material(board, chess.BLACK)
    diff = white - black
    if diff == 0:
        return f"White {white}, Black {black} (material is equal)"
    leader = "White" if diff > 0 else "Black"
    return f"White {white}, Black {black} ({leader} is up {abs(diff)} point{'s' if abs(diff) != 1 else ''})"


def _pv_ucis(board: chess.Board, sans: Sequence[str]) -> list[str]:
    b = board.copy(stack=False)
    out: list[str] = []
    for san in sans:
        try:
            mv = b.parse_san(san)
        except ValueError:
            break
        out.append(mv.uci())
        b.push(mv)
    return out
