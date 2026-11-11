"""Pydantic v2 models: the JSON contracts from ARCHITECTURE.md.

Field names follow the contract literally (camelCase where the contract uses it,
snake_case where it does not). Scores are ALWAYS from White's point of view.
"""
from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel, Field, ValidationInfo, field_validator
from pydantic_core import PydanticCustomError

# --------------------------------------------------------------------------- shared


class CpScore(BaseModel):
    cp: int


class MateScore(BaseModel):
    """Mate in N (positive: White mates, negative: Black mates).

    A position that is already checkmate is encoded as {"mate": 0}; the loser is
    the side to move in that position's FEN.
    """

    mate: int


Score = CpScore | MateScore


class EngineLine(BaseModel):
    multipv: int
    score: Score
    depth: int
    pv: list[str]
    pvUci: list[str]


Classification = Literal[
    "brilliant", "great", "best", "excellent", "good", "book",
    "inaccuracy", "mistake", "blunder", "miss",
]
CLASSIFICATIONS: tuple[str, ...] = get_args(Classification)

# --------------------------------------------------------------------------- openings


class OpeningNode(BaseModel):
    id: str
    san: str
    uci: str
    fen: str
    ply: int
    why: str
    nag: str
    lineIds: list[str]
    mainLine: bool
    categories: list[str]
    children: list["OpeningNode"] = Field(default_factory=list)


class OpeningSummary(BaseModel):
    id: str
    name: str
    side: Literal["white", "black"]
    eco: str = ""
    family: str = ""
    summary: str = ""
    lineCount: int
    mainLineSans: list[str]
    categoriesCount: dict[str, int]


class LineMeta(BaseModel):
    id: str
    name: str
    category: str
    description: str = ""
    evaluation: str = ""
    sans: list[str]
    finalFen: str


class OpeningFull(OpeningSummary):
    keyIdeas: list[str] = Field(default_factory=list)
    typicalPlans: list[str] = Field(default_factory=list)
    commonMistakes: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    lines: list[LineMeta]
    tree: OpeningNode


class QuizAnswer(BaseModel):
    san: str
    uci: str
    why: str
    lineIds: list[str]
    lineNames: list[str]


class LastOpponentMove(BaseModel):
    san: str
    why: str


class QuizItem(BaseModel):
    id: str
    openingId: str
    openingName: str
    fen: str
    sanPath: list[str]
    answers: list[QuizAnswer]
    kind: Literal["position", "trap"]
    lastOpponentMove: LastOpponentMove | None = None


# --------------------------------------------------------------------------- analysis


class AnalyzeRequest(BaseModel):
    """One-shot analysis. With neither depth nor movetime_ms the search runs to depth 18;
    with only movetime_ms it is time-limited; with both, whichever limit is hit first."""

    fen: str
    multipv: int = Field(default=3, ge=1, le=5)
    depth: int | None = Field(default=None, ge=1, le=60)
    movetime_ms: int | None = Field(default=None, ge=10, le=600_000)


class AnalyzeResponse(BaseModel):
    fen: str
    depth: int
    lines: list[EngineLine]


class WsAnalyzeInfo(BaseModel):
    type: Literal["info"] = "info"
    fen: str
    depth: int
    seldepth: int
    nodes: int
    nps: int
    lines: list[EngineLine]


# --------------------------------------------------------------------------- bot


_STOCKFISH_ELO = (400, 3190)
_PANICFISH_ELO = (0, 3600)  # it starts at 3600 and loses 300 per check
_MOVETIME_MS = (50, 60_000)

Variant = Literal["standard", "chess960", "crazyhouse", "kingofthehill", "3check", "antichess", "atomic", "horde", "racingkings"]


class BotMoveRequest(BaseModel):
    fen: str
    variant: Variant = "standard"
    bot: Literal["stockfish", "maia", "panicfish"] = "stockfish"  # before elo: its validator reads this field
    elo: int
    movetime_ms: int = 800  # the search time; ignored for Maia, which does not search
    moves: list[str] | None = None  # Maia only: UCI moves from start_fen, oldest first
    start_fen: str | None = None  # Maia only: the root of moves (default: the standard start)

    @field_validator("elo", "movetime_ms")
    @classmethod
    def _engine_limits(cls, value: int, info: ValidationInfo) -> int:
        """The engine's ranges, a 422 as always. Maia's rating is checked by the router (a 400)."""
        bot = info.data.get("bot")
        if bot == "maia":
            return value
        low, high = _MOVETIME_MS if info.field_name == "movetime_ms" else _PANICFISH_ELO if bot == "panicfish" else _STOCKFISH_ELO
        if value < low:
            raise PydanticCustomError("greater_than_equal", "Input should be greater than or equal to {ge}", {"ge": low})
        if value > high:
            raise PydanticCustomError("less_than_equal", "Input should be less than or equal to {le}", {"le": high})
        return value


class BotStrength(BaseModel):
    mode: Literal["uci_elo", "skill", "maia", "full", "random"]
    skill: int | None = None
    elo: int


class BotMoveResponse(BaseModel):
    uci: str
    san: str
    fen_after: str
    eval: Score | None
    strength: BotStrength


# --------------------------------------------------------------------------- pgn


class PgnParseRequest(BaseModel):
    pgn: str


class PgnMove(BaseModel):
    san: str
    uci: str
    fen: str


class PgnParseResponse(BaseModel):
    headers: dict[str, str]
    moves: list[PgnMove]
    startFen: str


# --------------------------------------------------------------------------- review


class Players(BaseModel):
    white: str = ""
    black: str = ""


class ReviewRequest(BaseModel):
    moves: list[str] = Field(min_length=1, max_length=1000)  # UCI or SAN
    startFen: str | None = None
    # The UI offers 12 / 16 / 20 (contract: 12-24); the API accepts 4-30 for quick tests.
    depth: int = Field(default=16, ge=4, le=30)
    players: Players | None = None


class BestMove(BaseModel):
    san: str
    uci: str
    pv: list[str]


class ReviewMove(BaseModel):
    ply: int
    san: str
    uci: str
    fenBefore: str
    fenAfter: str
    color: Literal["white", "black"]
    evalBefore: Score
    evalAfter: Score
    bestMove: BestMove
    playedPv: list[str]
    winPctBefore: float
    winPctAfter: float
    cpLoss: int
    classification: Classification
    # the piece the move gives up when it is the engine's best move (the test behind "brilliant")
    sacrifice: Literal["queen", "rook", "bishop", "knight"] | None = None
    bookWhy: str | None = None
    bookOpening: str | None = None
    explanation: str | None = None


class Accuracy(BaseModel):
    white: float
    black: float


class ClassificationCounts(BaseModel):
    white: dict[str, int]
    black: dict[str, int]


class ReviewOpening(BaseModel):
    id: str
    name: str
    lastBookPly: int


class ReviewResult(BaseModel):
    moves: list[ReviewMove]
    accuracy: Accuracy
    counts: ClassificationCounts
    opening: ReviewOpening | None = None
    depth: int
    engine: str


JobStatus = Literal["queued", "running", "done", "error"]


class ReviewJob(BaseModel):
    jobId: str
    status: JobStatus
    progress: float
    message: str | None = None
    result: ReviewResult | None = None


class ReviewCreated(BaseModel):
    jobId: str


# --------------------------------------------------------------------------- explain / system


class ExplainRequest(BaseModel):
    jobId: str
    ply: int = Field(ge=1)
    model: str | None = None
    language: str | None = Field(default=None, max_length=10)  # app language code: the answer's language


class ExplainResponse(BaseModel):
    text: str


# --------------------------------------------------------------------------- coach (single move)


class BookMoveNote(BaseModel):
    """A repertoire move and its explanation. ``san`` may also be given as UCI; ``uci`` is optional.
    ``nag`` is the repertoire's own annotation of the move ("!", "!?", "?!", "?", "??"), if any."""

    san: str
    why: str = ""
    uci: str | None = None
    nag: str | None = Field(default=None, max_length=4)


class CoachContext(BaseModel):
    openingName: str | None = None
    lineName: str | None = None
    studentSide: Literal["white", "black"] | None = None  # the side the student plays
    bookMoves: list[BookMoveNote] = Field(default_factory=list, max_length=40)  # before the move
    replyBookMoves: list[BookMoveNote] = Field(default_factory=list, max_length=40)  # after the move


class CoachRequest(BaseModel):
    requestId: str = ""  # echoed in every WS reply (POST ignores it)
    fen: str  # position BEFORE the move
    uci: str  # the move played (UCI; SAN is accepted too)
    explain: bool = True
    model: str | None = None
    depth: int = Field(default=14, ge=8, le=22)
    context: CoachContext | None = None
    language: str | None = Field(default=None, max_length=10)  # app language code: the answer's language


class CoachMove(BaseModel):
    san: str
    uci: str
    fenBefore: str
    fenAfter: str
    color: Literal["white", "black"]
    evalBefore: Score  # White POV, best play in fenBefore
    evalAfter: Score  # White POV
    bestMove: BestMove
    playedPv: list[str]
    winPctBefore: float  # mover POV, 0..100
    winPctAfter: float
    cpLoss: int
    classification: Classification  # never "miss"
    inBook: bool
    bookMove: BookMoveNote | None = None  # off-book with repertoire moves: what to play instead


class CoachResponse(BaseModel):
    move: CoachMove
    text: str
    coachError: str | None = None


class OllamaModel(BaseModel):
    name: str
    size: int = 0
    family: str = ""
    parameter_size: str = ""


class OllamaModelsResponse(BaseModel):
    models: list[OllamaModel]
    default: str


class StockfishHealth(BaseModel):
    name: str
    path: str


class OllamaHealth(BaseModel):
    ok: bool
    models: list[str]


class MaiaHealth(BaseModel):
    available: bool
    ratings: list[int]  # the ratings whose weight file exists
    path: str  # the lc0 executable


class FairyHealth(BaseModel):
    available: bool  # the file exists; it is not started to find out
    path: str


class HealthResponse(BaseModel):
    ok: bool
    stockfish: StockfishHealth
    ollama: OllamaHealth
    openings: int
    maia: MaiaHealth
    fairy: FairyHealth
