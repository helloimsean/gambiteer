# Gambiteer: backend

FastAPI + python-chess service for the trainer: opening trees and quizzes, Stockfish 19 analysis
(one-shot and live over a WebSocket), strength-limited bot moves, PGN parsing, game review with
chess.com-style classifications, Ollama explanations, and a single-move coach for the Learn tab's
practice mode. The JSON contracts are in
`../ARCHITECTURE.md`; the Pydantic models are in `app/schemas.py`.

## Run

```powershell
cd backend
pip install -r requirements.txt          # once (fastapi, uvicorn, python-chess, httpx, pydantic, pytest)
python -m uvicorn app.main:app --port 8000
```

* API at <http://localhost:8000/api/...>, interactive docs at <http://localhost:8000/docs>.
* If `frontend/dist` exists (after `npm run build` in `frontend/`), the backend serves it at `/`, and any
  unknown non-`/api`, non-`/ws` path gets `index.html`. During development use the Vite dev server on
  port 5173 instead (it proxies `/api` and `/ws` here; CORS also allows `http://localhost:5173`).
* `--reload` works too. On Windows it makes uvicorn use a SelectorEventLoop, which cannot start
  subprocesses, so the engine manager detects this and runs Stockfish on a private ProactorEventLoop
  thread instead (it logs a warning when it does). Without `--reload`, the engines run on uvicorn's own loop.
* Stop with Ctrl+C. The lifespan quits every Stockfish process (and kills any that hang for more than 3 s).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `STOCKFISH_PATH` | `engines/stockfish19.exe` | UCI engine executable |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server used for explanations |
| `OLLAMA_MODEL` | `gpt-oss:20b` | preferred explanation model; if it is not installed, the first installed model is used |
| `DATA_DIR` | `data/openings` | folder with the opening JSON files (schema: `tools/validate_opening.py`) |
| `FRONTEND_DIST` | `frontend/dist` | built frontend to serve at `/` |

Relative defaults are resolved from the project root (the folder that holds `start.ps1`). Other tunables
(threads, hash sizes, default depths, throttling) are in `app/config.py`.

## Layout

```
app/main.py            app factory: lifespan (engines, Ollama client, opening store, review jobs), CORS, static frontend
app/config.py          settings + env vars
app/engine.py          EngineManager: analysis / review / bot Stockfish processes, locks, live AnalysisStream
app/openings.py        load + merge opening lines into trees, quiz items; reloads when a data file changes
app/review.py          pure classification / win% / accuracy functions + ReviewService (asyncio jobs)
app/coach.py           single-move coach: engine verdict for one move (reuses review.py's pure functions)
app/bot.py             strength-limited move choice (UCI_Elo >= 1320, Skill Level + softmax mixing below)
app/ollama_client.py   httpx client for Ollama, prompt builders for review and coach moves (facts computed with python-chess)
app/chessutil.py       FEN/move parsing, score conversion, SAN PVs, SEE, hanging pieces
app/deps.py            access to the services stored on app.state
app/routers/           openings, analysis (+ /ws/analyze), bot, pgn, review (+ /ws/review/{id}), explain (+ /ws/explain), coach (+ /ws/coach), system
tests/                 pytest suite; tests/fixtures/alien-gambit.json is a small opening file for the tests
```

## Behaviour notes

* **Engines.** Three python-chess async engines start lazily (the analysis engine is warmed up in the
  background at startup): `analysis` (Threads 4, Hash 512), `review` (Threads 4, Hash 512), `bot`
  (Threads 2, Hash 128). Each has an `asyncio.Lock`. A one-shot `/api/analyze` (or a newer live
  analysis) preempts a running live analysis instead of waiting behind it. A dead engine is restarted on
  the next request. Invalid positions are rejected with 400 before they reach Stockfish.
* **Live analysis (`/ws/analyze`).** The first info usually arrives within a few ms of the fen. Updates
  are coalesced and throttled to at most 10 messages per second; deep in a search Stockfish reports less
  often, so expect a few messages per second there. A new fen (or `{stop: true}`) stops the previous search
  first; the server echoes the fen exactly as the client sent it. Bad input gets
  `{type: "error", message}`. A search stops by itself after 5 minutes (`ws_analyze_max_seconds`).
  Disconnecting mid-stream stops the search and frees the engine.
* **Bot.** At 1320 Elo and above, Stockfish's own `UCI_LimitStrength`/`UCI_Elo`. Below 1320 the strength
  is **approximate**: Skill Level `round((elo-400)/920*7)` at a shallow depth, plus picking among the
  top 5 moves with probability softmax(-cpLoss/T), T = 60 + (1320-elo)*0.35, moves losing > 500 cp
  excluded unless elo < 700. It has not been calibrated against rated play.
* **Review.** Moves may be UCI or SAN. Each position is analysed once with MultiPV 2 at the job's depth
  (the UI uses 12/16/20; the API accepts 4-30). Progress is pushed after every position. Jobs live in
  memory (the oldest finished ones are dropped beyond 50). "Book" means the SAN path is in the opening
  data and ply <= 30; the opening that follows the game longest names it. Jobs run one at a time and
  take the review engine's lock per position, so coach requests can run in between.
* **Coach (`POST /api/coach/move`, `WS /ws/coach`).** One move (`fen` before + `uci`) gets an engine
  verdict on the review engine (MultiPV 2 before, 1 after, depth 8-22, default 14; about 0.1-0.3 s)
  with the review classification rules, "book" when the move is in `context.bookMoves`, never "miss";
  then, unless `explain: false`, an Ollama explanation built from the same facts as the review prompt
  plus the repertoire context (student in book: why it is good, or honestly bad when the engine calls it
  a mistake, as in trap lines; student off book: a computed verdict against the repertoire move, honest
  when it is about as good; opponent: good or bad and what to play next). A failed explanation never hides the verdict: POST returns 200 with `coachError`, the socket
  sends `analysis` first and then `{type: "error", stage: "explain"}`. On the socket, verdicts are sent in
  request order without waiting for older explanations; explanations stream one at a time in request
  order; closing the socket drops pending work. Contract details: `../ARCHITECTURE.md` (Coach).
* **Explanations.** The prompt contains only facts from the review and python-chess (evals in pawns
  from the mover's view, best line, expected continuation, material now and after it, hanging pieces,
  what a capture takes, check, lost castling rights, the book "why"). Options: `num_ctx 4096,
  temperature 0.3, num_predict 220`. gpt-oss models get `think: "low"` and 300 extra `num_predict`
  because their reasoning tokens count against the limit. Finished explanations are stored on the
  review job (`explanation`).
* **Opening data.** Files that fail to parse are skipped with a warning (see the server log). The store
  re-reads `DATA_DIR` when a file is added, removed or changed (checked at most once a second), so data
  can be edited while the server runs.

## Tests

```powershell
cd backend
python -m pytest -q
```

Tests never need Ollama. Stockfish-backed tests are skipped when `STOCKFISH_PATH` does not exist. They
use the fixture opening in `tests/fixtures/`, not `data/openings`.
