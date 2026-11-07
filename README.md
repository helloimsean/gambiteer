<p align="center">
  <img src="frontend/public/logo.svg" width="128" height="128" alt="Gambiteer logo: a white knight with a gold !? badge">
</p>

<h1 align="center">Gambiteer</h1>

<p align="center">
  Learn chess openings line by line, practise them against an opponent that answers from your
  repertoire, and get every move explained by Stockfish 19 and a local AI coach.
</p>

> [!NOTE]
> **This project was made with AI.** The code, the opening research and notes, the logo and this
> documentation were written by [Claude](https://www.anthropic.com/claude) (Anthropic's AI model,
> using Claude Code), directed and tested by [@helloimsean](https://github.com/helloimsean). The
> opening lines were checked with Stockfish, but treat the notes like any study material and use
> your own judgement.

Gambiteer is a local web app with a dark, chess.com-style UI. Everything runs on your own PC: no
accounts, no cloud, no tracking. Stockfish does the chess; a local [Ollama](https://ollama.com)
model turns the engine's facts into plain-language explanations.

<table>
  <tr>
    <td><img src="docs/screenshots/learn-practice.png" alt="Learn: practising the Italian Game, with the coach explaining your move and the opponent's reply"></td>
    <td><img src="docs/screenshots/learn-gallery.png" alt="Learn: the opening gallery"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/analyze.png" alt="Analyze: Stockfish 19 lines and eval bar"></td>
    <td><img src="docs/screenshots/review.png" alt="Review: accuracy, classifications and an AI explanation"></td>
  </tr>
</table>

## Features

* **Learn**: every opening as a move tree, grouped lines (main, accepted, declined, sidelines,
  traps) and key ideas. Every move has a note on why it is played.
  * **Practice mode**: play your moves on the board and the opponent answers automatically from
    the line you are learning, or with a random variation from your repertoire.
  * **Coach**: every move (yours and the opponent's) gets a Stockfish verdict (Book, Best,
    Inaccuracy, Mistake, Blunder...) and an explanation from your local AI model, from your side of
    the board, including what to play next.
  * Moves outside the repertoire stay on the board: the coach says whether the move is actually
    good or bad compared with the repertoire move, and you can take it back.
* **Quiz**: line drills, position quizzes and trap puzzles from your repertoires. Positions you know
  badly come up more often.
* **Analyze**: a free analysis board with live Stockfish 19 lines (MultiPV 1-5), an eval bar,
  arrows, FEN/PGN import, and a label when the position is in your opening data.
* **Play**: play a Stockfish bot at Elo 400-3190, optionally from one of your opening lines.
* **Review**: chess.com-style game review (brilliant to blunder, accuracy, eval graph), with an AI
  explanation of why each move was good or bad.

### Openings included

| Opening | You play | Notes |
|---|---|---|
| Alien Gambit & Martian Gambit | White | knight sacrifices on f7 / e6 against the Caro-Kann, with every decline |
| Italian Game | White | Giuoco Piano, Evans Gambit, Two Knights, quiet lines and traps |
| Vienna Gambit | White | |
| Scotch Gambit | White | |
| Smith-Morra Gambit | White | against the Sicilian |
| Queen's Gambit | White | the d4 opening |
| London System | White | |
| Caro-Kann Defence | Black | against 1.e4 |
| Budapest Gambit | Black | against 1.d4 |

You can add your own (see [Adding an opening](#adding-an-opening)).

## Install (Windows 10/11)

### 1. Install the programs

| Program | Version | Used for |
|---|---|---|
| [Git](https://git-scm.com/download/win) | any | downloading the code |
| [Python](https://www.python.org/downloads/) | 3.12 or newer (tested with 3.14) | the backend |
| [Node.js](https://nodejs.org) | 20.19 or newer (LTS recommended) | building the web interface |
| [Ollama](https://ollama.com/download) | any recent version | the AI explanations (everything else works without it) |
| Stockfish 19 | step 4 below | analysis, bots, review, the coach's verdicts |

The quickest way is `winget` in a PowerShell or Command Prompt window:

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.13 -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Ollama.Ollama -e
```

If you use the python.org installer instead, tick **"Add python.exe to PATH"**. Close and reopen
your terminal afterwards so the new commands are found. Check with:

```powershell
git --version; python --version; node --version; ollama --version
```

### 2. Download Gambiteer

```powershell
cd $HOME\Documents          # or wherever you want it
git clone https://github.com/helloimsean/gambiteer.git
cd gambiteer
```

### 3. Install the Python and Node packages

```powershell
python -m pip install -r backend\requirements.txt
cd frontend; npm install; cd ..
```

(`start.bat` also runs `npm install` and builds the interface by itself if you skip the second line.)

### 4. Download Stockfish 19

Stockfish is not in the repository (the file is about 100 MB and has its own license). From the
`gambiteer` folder, in PowerShell:

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip" -OutFile "$env:TEMP\stockfish19.zip"
Expand-Archive "$env:TEMP\stockfish19.zip" -DestinationPath "$env:TEMP\stockfish19" -Force
Copy-Item "$env:TEMP\stockfish19\stockfish\stockfish-windows-x86-64-universal.exe" engines\stockfish19.exe
```

Or download it from <https://stockfishchess.org/download/>, unzip it and save the `.exe` as
`engines\stockfish19.exe`.

### 5. Download an AI model

Start Ollama (it runs in the system tray after installing), then pull a model:

```powershell
ollama pull gpt-oss:20b     # best explanations; needs a GPU with about 16 GB of VRAM (13 GB download)
ollama pull llama3.2:3b     # small and fast; works on smaller GPUs or the CPU (2 GB download)
```

One model is enough. Gambiteer uses `gpt-oss:20b` when it is installed and otherwise the first
model it finds; you can switch models in Settings.

### 6. Start it

Double-click **`start.bat`**. It builds the interface the first time, starts the backend and opens
<http://localhost:8000> in your browser. Keep the window open while you use the app; close it (or
press Ctrl+C) to stop.

The two dots at the bottom left of the app show whether Stockfish and Ollama were found.

Options can be passed on: `start.bat -Rebuild` (force a rebuild of the interface),
`start.bat -Port 8001` (if port 8000 is taken), `start.bat -NoBrowser`. You can also run
`start.ps1` directly: `powershell -ExecutionPolicy Bypass -File .\start.ps1`.

### Updating

```powershell
git pull
python -m pip install -r backend\requirements.txt
```

`start.bat` rebuilds the interface automatically when the code changed.

## Development

How it is built (API endpoints, JSON shapes, components, colours) is in
[ARCHITECTURE.md](ARCHITECTURE.md). Backend: FastAPI + python-chess. Frontend: Vite + React 19 +
TypeScript, chessground and chess.js.

Hot reload, in two terminals:

```powershell
# terminal 1: backend with auto-reload
cd backend
python -m uvicorn app.main:app --port 8000 --reload

# terminal 2: Vite dev server
cd frontend
npm run dev                # http://localhost:5173  (proxies /api and /ws to :8000)
```

Open <http://localhost:5173>. <http://localhost:5173/?dev=1> shows a playground with every shared
component and fake data (no backend needed).

Checks:

```powershell
cd backend;  python -m pytest -q        # backend unit + API tests (no Ollama needed)
cd frontend; npm run build              # type-check + production build (must be clean)
cd frontend; npx playwright install chromium   # once, for the browser checks below
cd frontend; npm run e2e                # full Playwright journey against http://localhost:8000
```

`npm run e2e` (`frontend/e2e/journey.e2e.mjs`) needs the backend on port 8000 with a fresh build,
Stockfish, and Ollama with `llama3.2:3b` (override with the `MODEL` and `DEPTH` environment
variables or a base URL argument). It clicks through all five tabs, fails on any page exception or
console error, and saves screenshots to `frontend/screenshots/`. Each tab also has more detailed
scripts next to its code (`frontend/src/tabs/*/*.e2e.mjs`, `*.check.mjs`).

## Adding an opening

Each opening is one JSON file in `data\openings\<id>.json`. The full schema is in the docstring of
[`tools/validate_opening.py`](tools/validate_opening.py). In short:

```jsonc
{
  "id": "my-opening",                  // must equal the file name
  "name": "My Opening",
  "side": "white",                     // the side YOU play: "white" or "black"
  "eco": "C50", "family": "1.e4 e5 ...",
  "summary": "2-5 sentences (at least 80 characters).",
  "keyIdeas": ["...", "...", "..."],   // 3-8 items
  "typicalPlans": [], "commonMistakes": [], "sources": ["https://..."],
  "lines": [
    { "id": "main", "name": "Main line", "category": "main",
      "description": "When this arises and what the plan is.", "evaluation": "=",
      "moves": [ { "san": "e4", "why": "Takes the centre.", "nag": "" }, ... ] }
  ]
}
```

Every line starts from the initial position and needs at least 6 plies. At least one line must have
category `main`. Each position needs at least one non-empty `why` somewhere in the file.
Categories: `main | accepted | declined | sideline | trap | transposition | alternative`. Mark
deliberate mistakes with a `nag` (`?`, `??`, `?!`) so the coach explains them as mistakes.

Validate before using it:

```powershell
python tools\validate_opening.py data\openings\my-opening.json           # errors -> exit code 1
python tools\validate_opening.py data\openings\my-opening.json --fix     # canonical SAN (O-O, +, #) + formatting
python tools\validate_opening.py data\openings\my-opening.json --engine  # Stockfish sanity check of every move
```

The backend notices new, changed or deleted files in `data\openings` (it checks at most once a
second), so just reload the page. Files that fail to load are skipped and the reason is logged in
the backend window.

To find opponent replies your file does not cover yet:

```powershell
python tools\check_coverage.py data\openings\my-opening.json --min-ply 2 --engine
python tools\check_coverage.py data\openings\my-opening.json --min-ply 2 --explorer   # needs a Lichess token, see below
```

### Lichess API token (only for `check_coverage.py --explorer`)

`--explorer` asks the Lichess opening explorer how often real players choose each reply. It needs
a free personal API token:

1. Log in at <https://lichess.org> and open <https://lichess.org/account/oauth/token>.
2. Click **+**, give it a description such as `gambiteer`, leave every scope unticked, and click
   **Create**. Copy the token (it starts with `lip_`); Lichess shows it only once.
3. Save it as the only content of a file named `.lichess_token` in the project root (this file is
   in `.gitignore`), or set it for the session: `$env:LICHESS_TOKEN = "lip_..."`.

Treat the token like a password; revoke it on the same page if it leaks. Explorer answers are
cached in `data\_cache\explorer`.

## Changing the AI model

* **In the app**: Settings (the gear at the bottom left) > *Explanation model*, or the model picker
  in the Review tab. "Backend default" lets the backend choose.
* **Backend default**: `gpt-oss:20b` if it is installed, otherwise the first installed model.
  Override it before starting: `$env:OLLAMA_MODEL = "llama3.2:3b"; .\start.bat`
* **More models**: `ollama pull <name>` (for example `qwen2.5:7b`), then reload the page.
* Ollama on another PC: `$env:OLLAMA_URL = "http://other-pc:11434"`.

Small models answer quickly but phrase things loosely; `gpt-oss:20b` gives better explanations but
needs a strong GPU. The explanations are built only from facts computed by Stockfish and
python-chess, but any model can still get a detail wrong. The badges and evaluations always come
from Stockfish.

Other backend settings (environment variables): `STOCKFISH_PATH`, `DATA_DIR`, `FRONTEND_DIST`.
Threads, hash sizes and depths are in `backend/app/config.py` (see `backend/README.md`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `python`, `node` or `ollama` is "not recognized" | Close and reopen the terminal after installing. For Python, reinstall with "Add python.exe to PATH" ticked. |
| `start.bat` window closes at once | Run it from a terminal (`.\start.bat`) to read the error. |
| "Port 8000 is already in use" | Another program uses the port. Close it, or run `start.bat -Port 8001`. |
| `Python packages are missing` | `python -m pip install -r backend\requirements.txt` |
| Page says `frontend not built` | `start.bat -Rebuild`, or `npm run build` in `frontend`. |
| Old interface after an update | `start.bat -Rebuild`, then reload the browser with Ctrl+F5. |
| Stockfish dot is red / "engine unavailable" | Check that `engines\stockfish19.exe` exists (step 4) or set `STOCKFISH_PATH`. Antivirus tools sometimes quarantine engines. |
| Ollama dot is red / "Coach unavailable" | Start Ollama (tray app, or `ollama serve`) and check that `ollama list` shows a model. Then click the refresh icon at the bottom left. |
| Explanations are slow | Use a smaller model (`llama3.2:3b`). The first request after loading a model is the slowest. |
| A new opening does not appear | Run `tools\validate_opening.py` on it; the backend log says why a file was skipped. |
| `npm run dev`: "Port 5173 is in use" | Another Vite server is running. Close it (the port is fixed because of the CORS settings). |
| `check_coverage.py --explorer`: `401 Unauthorized` | Add a Lichess token (see above). |

## Project layout

```
start.bat               double-click to start (runs start.ps1)
start.ps1               build the interface if needed, start the backend on :8000, open the browser
ARCHITECTURE.md         contracts: endpoints, JSON shapes, components, colours, file layout
backend/                FastAPI + python-chess (app/, tests/)            -> backend/README.md
frontend/               Vite + React + TypeScript, chessground, chess.js  -> frontend/README.md
  public/logo.svg       the Gambiteer logo
  e2e/journey.e2e.mjs   full end-to-end user journey (Playwright)
data/openings/          opening repertoires (JSON)
tools/                  validate_opening.py, check_coverage.py
engines/                put stockfish19.exe here (not in git)              -> engines/README.md
docs/screenshots/       pictures used in this README
```

## Contributors

* **[@helloimsean](https://github.com/helloimsean)**: idea, direction, testing.
* **[Claude](https://www.anthropic.com/claude)** (Anthropic, via Claude Code): code, opening
  research and notes, logo and documentation.

## Third-party software

Gambiteer uses [Stockfish](https://stockfishchess.org) (GPLv3, downloaded separately),
[python-chess](https://github.com/niklasf/python-chess) (GPLv3),
[chessground](https://github.com/lichess-org/chessground) (GPLv3),
[chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause), [FastAPI](https://fastapi.tiangolo.com)
(MIT), [React](https://react.dev) (MIT), [Vite](https://vite.dev) (MIT) and
[Ollama](https://ollama.com) (MIT). Opening statistics come from the
[Lichess opening explorer](https://lichess.org/analysis#explorer).
