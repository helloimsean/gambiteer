# Gambiteer: architecture and contracts

A local, single-user web app (chess.com-style dark UI) for learning opening repertoires, quizzing
them, analysing with Stockfish 19, playing bots at a chosen Elo, and reviewing games with Stockfish +
an Ollama LLM that explains each move.

Everything runs on this PC. No accounts, no cloud.

```
gambiteer\                 (project root)
  ARCHITECTURE.md          this file (contracts; keep it current when a contract changes)
  README.md                how to run
  start.ps1                one-click start (build frontend if needed, start backend, open browser)
  engines\stockfish19.exe  Stockfish 19 (universal x86-64 build; UCI_Elo 1320..3190, Skill Level 0..20)
  data\openings\*.json     opening repertoire files (schema: tools/validate_opening.py docstring)
  tools\                   data tooling (validate_opening.py, check_coverage.py)
  backend\                 FastAPI + python-chess (Python 3.14)
    app\main.py            app factory, CORS, static serving of frontend/dist, router includes
    app\config.py          paths and defaults
    app\engine.py          EngineManager: Stockfish process pool (analysis / bot / review)
    app\openings.py        load JSON files, merge into trees, quiz generation
    app\review.py          game review pipeline: evals, classification, accuracy
    app\coach.py           single-move coach: engine verdict for one practice move (reuses review.py)
    app\bot.py             strength-limited move selection
    app\ollama_client.py   Ollama HTTP client + explanation prompt builders (review move, coach move)
    app\routers\*.py       one router per feature (openings, analysis, bot, review, explain, coach, system)
    app\schemas.py         Pydantic models shared by routers (the JSON contracts below)
    tests\                 pytest
  frontend\                Vite 8 + React 19 + TypeScript; chessground 9 + chess.js 1.4
    src\App.tsx            shell: left nav, main board area, right panel; tab switching
    src\api\client.ts      typed fetch/WebSocket helpers for every endpoint below
    src\components\        Board, EvalBar, MoveList, EngineLines, ClassificationBadge, ...
    src\tabs\Learn\  Quiz\  Analyze\  Play\  Review\
    src\lib\               chess helpers (SAN/UCI, dests for chessground, win% math, tree utils)
    src\styles\            theme.css (CSS variables), chessground css imports
    e2e\journey.e2e.mjs    Playwright (chromium) journey through all tabs against :8000 (`npm run e2e`)
```

## Running

Dev: backend `uvicorn app.main:app --port 8000 --reload` (cwd `backend`), frontend `npm run dev` (cwd
`frontend`, port 5173, proxies `/api` and `/ws` to 8000). Prod: `npm run build` then the backend
serves `frontend/dist` at `/`. `start.ps1` does the prod path. End-to-end check: with the prod
backend on 8000, `npm run e2e` (cwd `frontend`).

## Opening data model (input)

Files `data/openings/<id>.json`; schema in `tools/validate_opening.py`. Short version: an opening has
`id, name, side ("white"|"black" = the side the student plays), eco, family, summary, keyIdeas[],
typicalPlans[], commonMistakes[], sources[], lines[]`; each line has `id, name, category
(main|accepted|declined|sideline|trap|transposition|alternative), description, evaluation, moves[]`;
each move is `{ san, why, nag }` and every line starts from the initial position.

### Merged tree (what the backend serves)

The backend merges all lines of an opening into one tree keyed by SAN path:

```ts
interface OpeningNode {
  id: string;            // stable: the SAN path joined by " " (e.g. "e4 Nf6 Nc3")
  san: string;           // move that led here ("" for root)
  uci: string;           // "e2e4"
  fen: string;           // position AFTER the move
  ply: number;           // 1 for 1.e4
  why: string;           // best non-empty explanation among lines through this node
  nag: string;           // "!?" etc, first non-empty
  lineIds: string[];     // lines passing through this node
  mainLine: boolean;     // node lies on a category "main" line
  categories: string[];  // union of categories of lines through this node
  children: OpeningNode[]; // ordered: main-line child first, then by (number of lines desc, san)
}
interface OpeningSummary { id, name, side, eco, family, summary, lineCount, mainLineSans: string[], categoriesCount: Record<string, number> }
interface OpeningFull extends OpeningSummary { keyIdeas, typicalPlans, commonMistakes, sources, lines: LineMeta[], tree: OpeningNode }
interface LineMeta { id, name, category, description, evaluation, sans: string[], finalFen: string }
```

## Backend HTTP API (all JSON, prefix `/api`)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, stockfish: { name, path }, ollama: { ok, models: string[] }, openings: number }` |
| GET | `/api/openings` | | `OpeningSummary[]` |
| GET | `/api/openings/{id}` | | `OpeningFull` (404 if unknown) |
| GET | `/api/openings/{id}/quiz?mode=positions|traps&limit=50` | | `QuizItem[]` (see Quiz) |
| POST | `/api/analyze` | `{ fen, multipv?: 1-5 (default 3), depth?: number (default 18), movetime_ms?: number }` | `{ fen, depth, lines: EngineLine[] }` one-shot analysis |
| WS | `/ws/analyze` | client sends `{ fen, multipv }` any time; server streams `{ type:"info", fen, depth, seldepth, nodes, nps, lines: EngineLine[] }` ~5-10/s (at most 10/s; `fen` echoed exactly as sent) until a new fen arrives or client sends `{ stop: true }`; bad input gets `{ type:"error", message }` | |
| POST | `/api/bot/move` | `{ fen, elo: 400-3190, movetime_ms?: number (default 800) }` | `{ uci, san, fen_after, eval: Score|null, strength: { mode: "uci_elo"|"skill", skill?: number, elo } }` |
| POST | `/api/pgn/parse` | `{ pgn }` | `{ headers: Record<string,string>, moves: { san, uci, fen }[] , startFen }` (400 on bad PGN) |
| POST | `/api/review` | `{ moves: string[] (UCI or SAN from the initial position), startFen?, depth?: 12-24 (default 16; the API also accepts 4-30), players?: { white, black } }` | `{ jobId }` (400 on an illegal move) |
| GET | `/api/review/{jobId}` | | `ReviewJob` (status: queued|running|done|error; progress 0..1; result when done) |
| WS | `/ws/review/{jobId}` | server pushes `ReviewJob` snapshots on progress, closes on done/error | |
| POST | `/api/explain` | `{ jobId, ply, model?: string }` | `{ text }` (non-streaming) |
| WS | `/ws/explain` | client sends `{ jobId, ply, model? }`; server streams `{ type:"token", text }` ... `{ type:"done", text }` or `{ type:"error", message }` | |
| POST | `/api/coach/move` | `CoachRequest` (see Coach) | `{ move: CoachMove, text, coachError? }` (400 bad FEN / illegal move, 422 bad shape e.g. depth outside 8-22, 503 no Stockfish; an Ollama failure is still 200 with `text: ""` and `coachError`) |
| WS | `/ws/coach` | one `CoachRequest` per client message, several may be in flight; replies carry `requestId`: `{ type:"analysis", requestId, move }`, then `{ type:"token", requestId, text }`*, then `{ type:"done", requestId, text }`, or `{ type:"error", requestId, stage:"analysis"\|"explain", message }` | |
| GET | `/api/ollama/models` | | `{ models: { name, size, family, parameter_size }[], default: string }` |

Shared types:

```ts
type Score = { cp: number } | { mate: number };   // ALWAYS from White's point of view
interface EngineLine { multipv: number; score: Score; depth: number; pv: string[] /* SAN */; pvUci: string[]; }
```

### Review result

```ts
type Classification = "brilliant"|"great"|"best"|"excellent"|"good"|"book"|"inaccuracy"|"mistake"|"blunder"|"miss";
interface ReviewMove {
  ply: number;              // 1-based
  san: string; uci: string;
  fenBefore: string; fenAfter: string;
  color: "white"|"black";
  evalBefore: Score;        // best play eval of fenBefore (white POV)
  evalAfter: Score;         // eval of fenAfter (white POV)
  bestMove: { san: string; uci: string; pv: string[] };   // engine's best in fenBefore
  playedPv: string[];       // engine PV after the played move (SAN)
  winPctBefore: number; winPctAfter: number;  // 0..100 from the MOVER's point of view
  cpLoss: number;           // centipawns lost by the mover (>= 0)
  classification: Classification;
  bookWhy?: string;         // if the move is in our opening data, its "why"
  bookOpening?: string;     // opening name from our data
  explanation?: string;     // filled by /api/explain
}
interface ReviewResult {
  moves: ReviewMove[];
  accuracy: { white: number; black: number };          // 0..100
  counts: { white: Record<Classification, number>; black: Record<Classification, number> };
  opening?: { id: string; name: string; lastBookPly: number };
  depth: number; engine: string;
}
interface ReviewJob { jobId: string; status: "queued"|"running"|"done"|"error"; progress: number; message?: string; result?: ReviewResult }
```

Classification rules (chess.com-like, implemented in `review.py`, unit-tested):

* win% (mover POV) `= 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)` with cp clamped to +-1500; mate = 100/0.
* `drop = winPctBefore - winPctAfter` (after is from the mover's POV, i.e. negate the after-score for Black).
* `book`: the position before AND the move are in our opening data (same SAN path from the start) and ply <= 30.
* `best`: played move == engine best move (compare UCI) and not brilliant/great.
* `brilliant`: played == best, the move sacrifices material (after the move, the moved piece or another piece worth >= 3 is capturable and SEE says it loses material, or a queen/rook is given up) and the position was not already > +600 cp for the mover and eval after stays >= -150 cp for mover.
* `great`: played == best, the second-best engine line is at least 10 win% worse than the best (only move), position not lost.
* `excellent`: drop < 2;  `good`: drop < 5;  `inaccuracy`: 5 <= drop < 10;  `mistake`: 10 <= drop < 20;  `blunder`: drop >= 20.
* `miss`: the opponent's previous move was a mistake/blunder (gave the mover >= 10 win%) and the mover's move drops >= 10 win% relative to best (replaces inaccuracy/mistake/blunder label only when the previous condition holds).
* accuracy per move (lichess formula) `= 103.1668 * exp(-0.04354 * drop) - 3.1669`, clamped 0..100; game accuracy = mean of per-move accuracies for that colour (plain mean is fine).

Engine use in review: evaluate every position once at the job's depth with MultiPV 2 (needed for
"great"), so a 40-move game = 81 analyse() calls. Report progress after each ply. Jobs run one at a
time; each position takes the `review` engine lock separately so single-move coach requests (see
Coach) can run between two positions.

### Explain (Ollama)

`ollama_client.py` builds a compact, factual prompt from the review data so the model cannot
hallucinate the position: side to move, move number, the move played (SAN), classification, eval
before/after in pawns from the mover's POV, engine best move + first 5 plies of its PV in SAN, the
played move's PV (5 plies), material balance, the list of pieces left hanging after the move (computed
with python-chess: attacked and not defended, or attacked by a lower-value piece), whether the king is
in check / castling rights lost, and the opening "why" if the move is book. The system prompt says:
"You are a chess coach. Explain in 2-4 short sentences, plain language, for a club player, why this
move is <classification>. Only refer to the moves and facts given; do not invent moves. If the move was
best, say what it achieves; otherwise say what the engine's move achieves instead." Default model is
`gpt-oss:20b` when installed (for gpt-oss pass `"think": "low"`), else the first installed model.
Options: `num_ctx 4096, temperature 0.3, num_predict 220` (gpt-oss gets +300 `num_predict` because its
reasoning tokens count against the limit). Stream tokens to the client. The model list
comes from Ollama's `/api/tags`.

### Coach (single move, Learn tab practice)

A Stockfish verdict plus an Ollama explanation for ONE move, outside any game review: the Learn tab
sends every practice move (the student's and the opponent's automatic reply) to it.

```ts
interface BookMoveNote { san: string; why: string; uci?: string; nag?: string }   // san may also be UCI; nag = the repertoire's own "!", "!?", "?!", "?", "??"
interface CoachRequest {
  requestId: string;          // echoed in every WS reply (POST ignores it; optional there)
  fen: string;                // position BEFORE the move
  uci: string;                // the move played (must be legal in fen; SAN is accepted too; king-takes-rook castling such as e1h1 is normalized to e1g1)
  explain?: boolean;          // default true: also stream an Ollama explanation
  model?: string;             // Ollama model; default = backend default (gpt-oss:20b when installed)
  depth?: number;             // 8-22, default 14 (fast: this runs on every practice move)
  context?: {
    openingName?: string; lineName?: string;
    studentSide?: "white" | "black";        // the side the student plays (default: the mover)
    bookMoves?: BookMoveNote[];             // repertoire moves in the position BEFORE the move (may be empty)
    replyBookMoves?: BookMoveNote[];        // repertoire replies AFTER the move (what the other side plays next)
  };
}
interface CoachMove {
  san: string; uci: string; fenBefore: string; fenAfter: string; color: "white" | "black";
  evalBefore: Score; evalAfter: Score;            // White POV, like ReviewMove
  bestMove: { san: string; uci: string; pv: string[] };   // engine best in fenBefore
  playedPv: string[];
  winPctBefore: number; winPctAfter: number;      // mover POV 0..100
  cpLoss: number;
  classification: Classification;                 // review rules; "book" when the move is in context.bookMoves; never "miss"
  inBook: boolean;
  bookMove?: BookMoveNote;    // when NOT inBook and bookMoves is non-empty: the first repertoire move (uci filled in when legal)
}
// POST response: { move: CoachMove, text: string, coachError?: string }  (optional fields are omitted, not null)
```

* **Engine** (`app/coach.py`): on the `review` engine, `fenBefore` with MultiPV 2 (for "great") and
  `fenAfter` with MultiPV 1 at the requested depth; win%, cpLoss and the label come from the review
  pipeline's pure functions (`build_review_result` for a one-move game), so the rules are identical
  except: "book" = the move matches `context.bookMoves` by SAN (check marks / `!?` ignored) or UCI, at
  any ply; "miss" cannot happen (no previous move). A position without legal moves after the move
  (mate / stalemate) needs no engine call (`{mate: 0}` / `{cp: 0}`). For an off-book move by the
  student, when an explanation is wanted, the position after the first repertoire move is evaluated
  too (taken from the MultiPV-2 lines when it is one of them, else one extra search) so the coach can
  compare the move with the repertoire move. The engine lock is taken once per request; review jobs
  take it per position (and run one job at a time), so a coach request during a review waits for at
  most one position (typically well under a second at depth 16-18) instead of the whole review.
* **Prompt** (`build_coach_messages` in `ollama_client.py`): the same facts as `build_explain_messages`
  (shared `_fact_sheet`: evals in pawns from the mover's POV, best line, expected continuation,
  material, hanging pieces, captures, check, castling) with mate phrases naming the side, plus the
  engine's rating ignoring theory, the position in plain words (about equal / slightly / clearly
  better / winning), the piece difference at the end of the expected continuation, and the training
  context: (1) student, in book: why this repertoire move is good, building on its note (an engine
  "inaccuracy" gets a one-clause caveat). A repertoire move the engine calls a mistake or blunder is
  explained honestly as bad ("what goes wrong") only when the note's `nag` marks it bad ("?", "??",
  "?!": the trap a line warns about); otherwise (a gambit or sacrifice, e.g. the Alien Gambit's
  6.Nxf7!?) the engine's objection comes in one sentence, then the idea from the note (what the
  student gets for the material); (2) student, off book: a computed verdict
  "about as good as" (within 5 win%) / "better than" / "slightly / clearly / much worse than" the
  repertoire move (with its note); (3) opponent: the verdict on the opponent's move, the eval from the
  student's POV, and what the student should play next (`replyBookMoves` with notes, else the engine's
  reply; a first reply whose `nag` marks it bad is a warning, not a recommendation). The coach facts
  also list every piece on the board after the move (bishops with their square colour), the net
  material result of the move + expected continuation for the student in words ("White gives up a
  knight for 2 pawns (net -1 point for White)"), the engine's best move with its move number and
  side, and a stalemate / insufficient-material draw on the board (also in the task, and "a draw by
  stalemate" instead of "about equal"). 2-4 short sentences, speaking to the student as "you", no
  invented moves, pieces, pins or material gains.
* **WS** (`routers/coach.py`): per socket, an analysis worker handles requests strictly in arrival
  order and sends `analysis` as soon as the engine is done, then hands the request to an explanation
  worker that streams explanations one at a time, also in arrival order. So a new request's verdict
  never waits behind an older request's slow LLM stream, and tokens of two requests are never
  interleaved. `analysis` always comes before any token or explain error (Ollama down = `analysis`
  then `{type:"error", stage:"explain"}`); `explain: false` gives `analysis` then `done` with `text: ""`.
  Nothing is cancelled: a client that wants to drop queued work closes the socket (the server then
  cancels its in-flight work and frees the engine). A message that is not valid JSON or not a
  `CoachRequest` gets `{type:"error", stage:"analysis", requestId}` (`requestId` is `""` when it could
  not be read); more than 64 queued requests on one socket are refused the same way.

### Bot strength (`bot.py`)

* elo >= 1320: a dedicated engine instance with `UCI_LimitStrength=true, UCI_Elo=elo`, `Threads 2`,
  `movetime_ms` (default 800 ms). Return the move and the limited engine's own score if available.
* elo < 1320: `Skill Level` = `round((elo - 400) / 920 * 7)` clamped 0..7 at depth `max(2, round((elo-400)/920*8)+1)`,
  AND a mixing step: ask for MultiPV 5 at that depth and pick move i with probability
  softmax(-cpLoss_i / T) where `T = 60 + (1320 - elo) * 0.35` centipawns. Cap any chosen move's
  cpLoss at 500 unless elo < 700. Document that sub-1320 strength is approximate.
* Never let UCI_LimitStrength leak into the analysis engine: separate processes.

### EngineManager (`engine.py`)

Three lazily-started python-chess async UCI engines (`chess.engine.popen_uci`): `analysis` (Threads
4, Hash 512, MultiPV per request), `review` (Threads 4, Hash 512; review jobs and the single-move
coach), `bot` (Threads 2, Hash 128). Each
has an `asyncio.Lock`. The analysis WebSocket uses `engine.analysis(board, multipv=n)` and iterates
`async for info in analysis` with throttling; on a new fen it calls `analysis.stop()` first. On app
shutdown quit all engines. Windows note: uvicorn's default Proactor loop supports subprocesses; keep
engines on the main loop (do not create engines inside threads). Exception: `uvicorn --reload` on
Windows runs a SelectorEventLoop, which cannot spawn subprocesses; the manager detects that and runs
all engines on one private ProactorEventLoop thread, proxying every call to it.

## Frontend

Stack: Vite 8, React 19, TypeScript, chessground 9 (board), chess.js 1.4 (rules). No router: `App`
holds `activeTab`. State per tab lives in that tab's component (lift to `App` only what must survive
tab switches: the last played game for Review, the current analysis position for "Analyze this").
Styling: plain CSS modules or global CSS with variables in `src/styles/theme.css`. No UI framework.

Look (chess.com-like): page bg `#262421`, panel bg `#312e2b`, panel border `#3c3936`, text
`#e8e6e3`, muted `#9e9c99`, accent green `#81b64c` (primary buttons), board light `#eeeed2`, dark
`#769656`, highlight last move `rgba(255,255,0,0.45)`, check red. Left nav 64-220 px with icons and
labels: Learn, Quiz, Analyze, Play, Review. Board fills the main column (square, max 85vh, min 320 px),
right panel 360-420 px. Mobile is not a target but nothing should break below 1100 px.

Chessground: import `chessground/assets/chessground.base.css`, `chessground.brown.css`,
`chessground.cburnett.css`; create with `Chessground(el, config)` in a `useEffect`, keep the `Api` in a
ref and call `api.set({...})` on prop changes. Compute legal `movable.dests` from chess.js
(`moves({verbose:true})`). Promotion: show a small chooser overlay (queen default on right-click).
Board props: `fen, orientation, lastMove?, check?, interactive, onMove(from,to,promotion?), shapes?
(arrows: { orig, dest, brush })`. Add a `coordinates` toggle. Piece move sounds via WebAudio (short
synthesized click for move, lower thud for capture; mutable).

Shared components: `Board`, `EvalBar` (vertical, white share from win%; shows +1.3 / M3 label),
`MoveList` (numbered pairs, current move highlighted, click to jump, optional per-move badges),
`EngineLines` (MultiPV rows: score, depth, PV in SAN; click a PV move to play it), `OpeningTree`
(collapsible tree, main line bold, variation names), `ClassificationBadge` (icon + colour per
classification; chess.com palette: brilliant `#1baca6` "!!", great `#5c8bb0` "!", best `#95bb4a` star,
excellent `#96bc4b`, good `#96af8b`, book `#a88865` book icon, inaccuracy `#f7c631` "?!", mistake
`#ffa459` "?", blunder `#fa412d` "??", miss `#ff7769` "X"), `Toolbar`, `Select`, `Toggle`, `Modal`.

Tabs:

* **Learn**: opening gallery (cards: name, side badge, ECO, line count, one-line summary; primary
  openings first), then the opening view: board (oriented to the student's side) + right panel with
  tabs "Tree" (`LearnTree`, the Learn tab's own variant of `OpeningTree` with line-start chips and
  the active line highlighted; clicking a node jumps the board there and plays the move with a short
  animation), "Lines" (grouped by category: Main, Accepted, Declined, Alternatives, Sidelines, Traps,
  Transpositions; click a line to load it and step through), "Ideas" (summary, key ideas, plans,
  common mistakes, sources). Under the board: the current move in big type with its NAG, the coach
  card (below), the names of the lines through this node, and prev/next/first/last buttons (arrow
  keys too), "Autoplay", "Practice". A "Quiz this opening" and an "Analyze this position" button.
  **Practice** (`useLearnPractice.ts`): a repertoire move played on the board is answered by the
  opponent after 600 ms with the followed line's next move, or (option "Random variation") a child of
  the tree weighted by line count, which switches the followed line. Options (gear menu, persisted in
  `learn-practice-v1`): Auto-reply (default on; then the board only moves the student's side and an
  opponent turn reached by browsing offers "Play opponent's move" / Space), Opponent replies, Coach
  explains every move. Browsing (arrows, tree, lines, autoplay) never triggers a reply and cancels a
  pending one; the reply timer re-checks the position. "Practice" rewinds the line and plays the
  opponent's first move when the student is Black. An off-book move stays on the board with the
  engine verdict, a green arrow for the repertoire move and the coach's comparison, until "Take back"
  (Backspace / Esc / Left); no reply off book. The end of the line shows "Line complete" (moves
  played, off-book attempts, Practice again, Next line = a random other line, preferring main /
  accepted / declined lines not completed this session; a new run starts when the student plays
  their first move again). A repertoire move the tree only has after another move order
  (transposition: same position, FEN without counters) counts as in book: the board jumps to that
  node, and the coach's `bookMoves` / `replyBookMoves` are the union of every node with the
  position. While practising (after Practice, a board move or the opponent's reply; cleared by any
  browsing) the next-move arrows are hidden on the student's own turn; the arrows button then shows
  them for that position as a hint. The Previous button with an off-book move on the board takes it
  back (like Left); Esc with the Practice options menu open only closes the menu. A reply still
  pending when the view unmounts (tab switch, reload) is kept in sessionStorage
  (`learn-reply-pending-v1`) and played when the view returns to that position. **Coach card** (`LearnCoachCard.tsx`,
  `useLearnCoach.ts`): for the student's last move and the opponent's reply: classification badge
  ("book" for repertoire moves, plus the engine's own label when a repertoire move drops >= 5 win%),
  eval after the move, the book `why`, and the explanation streamed from `/ws/coach` (opponent moves
  explained from the student's side). Practice moves always get an engine verdict and, when "Coach
  explains every move" is on, an explanation with `settings.ollamaModel`; any node can "Ask the
  coach". Engine verdicts are cached per (opening, node) for every model; explanations per (opening,
  model, node, line variant), where the variant is the followed line's part of the prompt (the
  recommended reply after an opponent move, the compared repertoire move after an off-book move; ""
  for the student's repertoire moves), in memory and in `learn-coach-v2` (newest 300 of each; the
  old node-keyed `learn-coach-v1` is deleted). Changing the model keeps the verdicts and asks the new
  model for the moves in focus. Replies are matched by `requestId`. The explanations of the moves on
  screen and of the pair just left are kept (so the opponent's reply still gets explained after the
  student moves on); when a new explanation is needed, or one on screen waits behind, while
  explanations of older moves are queued or streaming, the socket is replaced: those are dropped and
  the kept ones re-sent, the moves on screen first (nothing is restarted when the moves on screen are
  already ahead). Asked-for work that was dropped or lost (unmount, reload) is remembered in
  sessionStorage (`learn-coach-wanted-v1`) and resumed when its move is on screen again. On short
  screens a bar pinned to the bottom of the card names the opponent's reply (move, badge, eval) when
  its row is below the fold, and scrolls to it. Ollama down = verdict + "Coach unavailable"; coach
  socket down = the book `why` and practice keep working.
* **Quiz**: choose opening(s) and mode. (1) **Line drill**: pick a line (or "random line"); the
  student plays their side, the app auto-plays the opponent's reply from the line; a wrong move shakes
  the board, shows the `why` of the correct move after the second miss, and counts a mistake; at the
  end show score and offer the next line. (2) **Position quiz**: random tree positions where the
  student is to move; any child move in the tree counts as correct (show which line it belongs to and
  the why); wrong = reveal. (3) **Traps**: positions from `trap` lines where the opponent just went
  wrong; find the punishing move(s) to the end of the tactic. Progress per position is stored in
  `localStorage` (key `quiz-stats-v1`: `{ [openingId]: { [nodeId]: { correct, wrong, lastSeen } } }`)
  and weakly-known positions are asked more often. Show streak, score, and per-opening mastery %.
* **Analyze**: analysis board with free moves (variation-free linear history with "undo to here"),
  FEN/PGN import box, flip, "Engine on" toggle, MultiPV 1-5, live lines from `/ws/analyze`, eval bar,
  best-move arrow (and second best fainter), depth/nodes display, copy FEN/PGN, "Set up position"
  (edit FEN text), and an "Opening" label when the current SAN path matches our data (show the `why`).
* **Play**: new-game dialog: colour (white/black/random), Elo slider 400-3190 (show "Stockfish 19,
  UCI_Elo" above 1320 and "approximate (Skill Level + mixing)" below), bot move time (0.3/0.8/2 s),
  optional "Start from an opening line" (pick opening + line: the game starts at the end of that line,
  or "play the opening with hints" where the student's book moves are confirmed with a green check).
  During play: clocks are not needed; show captured pieces and material difference, move list, resign,
  takeback, flip, "hint" (one-shot `/api/analyze` best move arrow). Game over modal (mate, stalemate,
  draw by rule, resign) with "Review this game" (hands the move list to Review) and "Rematch".
* **Review**: input = last played game or pasted PGN (`/api/pgn/parse`); settings = depth (12 fast /
  16 default / 20 deep) and Ollama model (from `/api/ollama/models`). Run: progress bar fed by
  `/ws/review/{jobId}`. Result: header with accuracy per side (big numbers like chess.com), count table
  of classifications per side with badges, an SVG eval graph (white-advantage area chart, clickable),
  the move list with badges; selecting a move shows the board at that position with an arrow for the
  played move and the engine best move (green), the eval before/after, the best line, the book `why`
  if any, and the LLM explanation panel with an "Explain" button (streams via `/ws/explain`) plus
  "Explain all key moments" (runs sequentially over inaccuracies/mistakes/blunders/misses/brilliants).
  Keyboard left/right navigates.

## Quiz items (served by the backend)

```ts
interface QuizItem {
  id: string;                  // node id of the position (SAN path before the answer)
  openingId: string; openingName: string;
  fen: string;                 // position where the student is to move
  sanPath: string[];           // moves so far
  answers: { san: string; uci: string; why: string; lineIds: string[]; lineNames: string[] }[]; // all acceptable
  kind: "position"|"trap";
  lastOpponentMove?: { san: string; why: string };
}
```

`mode=positions`: every tree node (depth >= 1) where the student is to move and has >= 1 child.
`mode=traps`: nodes on `trap` lines where the opponent just played a move whose line continues with
the student's punishing move; `answers` holds only the trap continuation(s).

## Conventions

* Scores are always White-POV in the API; the frontend converts for display.
* UCI for moves on the wire; SAN for display (the backend includes both wherever convenient).
* Python: type hints, `ruff`-clean style, no global mutable state except the EngineManager singleton
  created in the FastAPI lifespan. Tests must not require Ollama; engine tests may be skipped when the
  exe is missing.
* TypeScript: `strict`, no `any` in exported types, no default exports except pages.
* Keep this file updated when a contract changes.
