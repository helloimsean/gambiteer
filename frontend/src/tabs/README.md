# Tab implementation guide

This folder holds the five feature tabs. Each tab is owned by one agent and lives entirely in its
own folder:

```
src/tabs/Learn/LearnTab.tsx      export function LearnTab(): JSX.Element
src/tabs/Quiz/QuizTab.tsx        export function QuizTab(): JSX.Element
src/tabs/Analyze/AnalyzeTab.tsx  export function AnalyzeTab(): JSX.Element
src/tabs/Play/PlayTab.tsx        export function PlayTab(): JSX.Element
src/tabs/Review/ReviewTab.tsx    export function ReviewTab(): JSX.Element
```

`App.tsx` imports exactly those named exports. Keep the file name and the export name, and replace
the placeholder contents with your implementation. Each tab's behaviour is specified in
`ARCHITECTURE.md` ("Frontend" > "Tabs"), and those contracts are binding.

## Ownership rules

* Only create or modify files inside **your** tab folder (`src/tabs/<Tab>/`).
* Sub-components, hooks, CSS and helpers that only your tab needs also go there, **prefixed with
  the tab name**: `LearnGallery.tsx`, `QuizLineDrill.tsx`, `useAnalyzeEngine.ts`,
  `ReviewGraph.tsx`, `ReviewTab.css`. If you need a new "shared" component, still build it in your
  folder with your prefix (`PlayCapturedPieces.tsx`). Mention it in your report so it can be
  promoted later.
* Do **not** edit `src/components/`, `src/lib/`, `src/api/`, `src/state/`, `src/styles/`,
  `src/dev/`, `App.tsx`, `main.tsx`, `vite.config.ts` or `package.json`. If a shared piece is
  missing or buggy, work around it in your folder and report it.
* CSS: prefix your class names with the tab name (`.learn-gallery`, `.quiz-score`). Global CSS is
  shared by every tab, so an unprefixed `.header {}` would leak.
* Named exports only (no default exports).
* TypeScript is `strict`, with `noUnusedLocals`/`noUnusedParameters`, and `npm run build` must stay
  at zero errors. `verbatimModuleSyntax` is on, so type-only imports must use `import type { ... }`.
  `erasableSyntaxOnly` is on, so `enum`, `namespace` and constructor parameter properties are not
  allowed.
* React 19: `JSX` is not global. Use `import type { JSX } from 'react'`.
* Tabs are unmounted when inactive. Clean up every timer, socket and listener in effect cleanups.
  Each tab is wrapped in an error boundary, so a crash shows an error card instead of a blank app.
  Still, do not rely on it.

## Running

```
# terminal 1: backend (cwd backend/)
uvicorn app.main:app --port 8000 --reload

# terminal 2: frontend (cwd frontend/)
npm run dev            # http://localhost:5173, proxies /api and /ws to :8000
npm run build          # type-check + production build into dist/ (must pass)
npm run check:board    # Playwright smoke test of the shell + Board (needs `npm run dev` running)
```

The component playground at **http://localhost:5173/?dev=1** shows every shared component with
fake data (no backend needed). It is the quickest way to see how `Board`, `EvalBar`, `MoveList`,
`EngineLines`, `OpeningTree`, the badges and the standard workspace layout look and behave.

## Layout

`src/styles/theme.css` defines the palette as CSS variables: `--bg`, `--panel`, `--panel-2`,
`--border`, `--border-strong`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--danger`,
`--warn`, `--cls-<classification>`, `--side-w` and so on. It also defines these utility classes:

* panels: `.panel` / `.panel-header` / `.panel-title` / `.panel-body` (`.scroll`) / `.panel-footer` / `.panel-tabs`
* `.card` (`.clickable`)
* buttons: `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-danger` / `.btn-sm` / `.btn-lg` / `.btn-icon` / `.btn-block` / `.btn-group` (`.active`)
* badges: `.badge` (`-white -black -green -red -yellow -blue -eco`)
* form fields: `label.field` > `span.field-label`
* layout helpers: `.row` / `.col` / `.wrap` / `.spacer` / `.grow` / `.scroll-y`
* text helpers: `.muted` / `.dim` / `.mono` / `.bold` / `.truncate`
* misc: `.kbd`, `.progress > span`, `.status-dot` (`.ok .bad .unknown`), `.nag` (`.good .bad`), `.fade-in`

The standard two-column tab layout is ready-made. The playground has a live example:

```tsx
<div className="workspace">
  <div className="workspace-board" style={{ '--below-board-h': '120px' } as CSSProperties}>
    <div className="board-frame">
      <EvalBar score={score} orientation={orientation} fen={fen} />   {/* optional */}
      <Board fen={fen} orientation={orientation} ... />
    </div>
    {/* controls under the board */}
  </div>
  <div className="workspace-side">
    <div className="panel grow"> ... </div>
  </div>
</div>
```

* `.workspace` is a grid, `minmax(0,1fr) var(--side-w)` (side panel 360-400 px), filling the main
  area (which is exactly the viewport height; the page itself never scrolls).
* `.workspace-board` is a CSS size container. `.board-frame` takes the column width, but never more
  than the column height minus `--below-board-h` (default 64px: one row of buttons) and never more
  than 85vh. If you put more under the board (move text, a "why" paragraph), raise
  `--below-board-h` so the board shrinks instead of pushing your controls off-screen.
* `Board` is always square and fills the width it is given. `EvalBar` stretches to the board's
  height when it sits next to it in a flex row (as in `.board-frame`).
* Nothing may break at 1100 px wide. The nav collapses to icons under 1200 px.

## AppContext

```tsx
import { useApp } from '../../state/AppContext'

const {
  activeTab, navigate,                 // navigate('analyze', { fen }) etc.
  lastGame, setLastGame,               // last finished game (Play writes it, Review reads it); persisted
  analyzeRequest, reviewRequest, quizRequest, learnRequest, playRequest,
  clearRequest,                        // clearRequest() clears the active tab's request
  settings, setSettings,               // { sound, coordinates, ollamaModel, defaultDepth }; persisted
  health, healthError, refreshHealth,  // GET /api/health (null until the first answer)
} = useApp()
```

Cross-tab hand-offs (payload types are exported from `state/AppContext.tsx`):

| Call | Target consumes |
|---|---|
| `navigate('analyze', { fen })` or `{ sans, startFen? }` | `analyzeRequest` |
| `navigate('review', { sans, players?, startFen? })` | `reviewRequest` |
| `navigate('quiz', { openingId, lineId?, mode? })` (`mode`: `'line' \| 'positions' \| 'traps'`) | `quizRequest` |
| `navigate('learn', { openingId, nodeId? })` (`nodeId` = SAN path joined by spaces) | `learnRequest` |
| `navigate('play', { openingId?, lineId?, color? })` | `playRequest` |
| `navigate(tab)` (no payload) | just switches tab |

Consume a request in an effect, then clear it so it does not fire again:

```tsx
const { analyzeRequest, clearRequest } = useApp()
useEffect(() => {
  if (!analyzeRequest) return
  if (analyzeRequest.fen) loadFen(analyzeRequest.fen)
  else if (analyzeRequest.sans) loadSans(analyzeRequest.sans, analyzeRequest.startFen)
  clearRequest()            // or clearRequest('analyze')
}, [analyzeRequest, clearRequest])
```

The request is still there when your tab mounts after `navigate` (it is set before the switch).

`LastGame` is `{ sans, startFen?, players?, result?, reason?, playedAt }`. Play should call
`setLastGame(...)` when a game ends, then `navigate('review', game)` with that `LastGame` for
"Review this game". Review opens its setup card on the game it was sent (or on `lastGame`) and
starts only when the Game Review button is pressed, so the depth and model can be chosen first.

Settings:

* `settings.coordinates`: pass it to every `Board`.
* `settings.sound`: already applied as a global mute (the Board and `playSound` obey it).
* `settings.ollamaModel`: `""` means "backend default", so omit `model` from the request.
* `settings.defaultDepth`: 12, 16 or 20, used by Review.

Lift to `AppContext` only what must survive a tab switch (`lastGame` is already there). Everything
else is local state, or `localStorage` through `src/lib/storage.ts` (e.g. `quiz-stats-v1`).

## Board

```tsx
import { Board, type BoardShape } from '../../components/Board'

<Board
  fen={fen}                          // required; the board always shows this position
  orientation="white"                // 'white' | 'black'
  lastMove={lastUci}                 // "e2e4" | [from, to] | null
  interactive                        // false = no moving/selecting (right-click arrows still work)
  movableColor="white"               // 'white' | 'black' | 'both' (= side to move) | 'none'
  onMove={(from, to, promotion) => { /* validate with chess.js, then set the new fen */ }}
  shapes={[{ orig: 'e2', dest: 'e4', brush: 'green' }, { orig: 'g1', brush: 'red' }]}
  coordinates={settings.coordinates}
  animation={200}                    // ms; false disables
  shake={shakeCounter}               // change the number to shake the board (wrong quiz move)
  sound                              // default true; obeys the global mute
/>
```

Behaviour you can rely on (all covered by `npm run check:board`):

* **Controlled.** `onMove` is a request. Accept a move by setting the new `fen` (synchronously in
  the handler is best). Reject it by leaving `fen` unchanged, and the piece snaps back on the next
  frame. If you validate asynchronously (e.g. wait for the server), the piece snaps back first and
  jumps forward when the new fen arrives. For a wrong move, call `playSound('illegal')` from
  `lib/sounds` (or bump `shake`).
* Legal destinations come from chess.js (the `dests` prop overrides them; `rules` replaces chess.js altogether for a variant position). `movableColor="white"`
  only allows moves when it is White's turn, which is what Play needs while the bot thinks.
* Promotions open an overlay chooser. `onMove` is called once, with `'q' | 'r' | 'b' | 'n'`.
  Right-click picks a queen and Esc cancels.
* Castling works by moving the king two squares or by dropping it on its own rook. `onMove` always
  receives the standard form (`e1g1`, `e1c1`), so `chess.move({ from, to })` just works.
* En passant and castling are drawn correctly as soon as you pass the new fen.
* Check highlighting is automatic (from the fen). Pass `check={false}` to suppress it.
* Sounds play on `fen` changes (your move / the other side's move / capture / castling / check), so programmatic moves (bot replies,
  autoplay, stepping through a game) sound right without extra code. Changes closer together than
  70 ms play one sound.
* Rapid `fen` changes (e.g. 25 ms apart) are fine: the board animates and always ends on the last
  fen. Arrows the user drew with right-click survive shape/prop updates and are cleared when the
  position changes.
* `shapes` brushes: `green red blue yellow paleGreen paleRed paleBlue paleGrey purple pink white`.
  An optional `label` adds text on the arrow, and `lineWidth` overrides the width. For the Analyze
  best/second-best arrows, use e.g. `green` + `paleGreen`. For Review, `paleBlue` = played and
  `green` = best.
* One chessground instance per mounted Board, destroyed on unmount. Toggling `coordinates`
  rebuilds it (cheap).
* The root element carries `data-fen` and `data-orientation` (handy for tests).

## Other shared components

| Component | Key props |
|---|---|
| `EvalBar` | `score` (White POV, nullable), `orientation`, `fen?` (lets `{mate:0}` fill the bar for the winner), `showLabel?` |
| `MoveList` | `moves: string[]` (SAN), `currentPly` (0 = start), `onSelect(ply)`, `startPly?` (when the game starts from a mid-game fen), `renderBadge?(ply, san)`, `emptyText?` |
| `EngineLines` | `lines`, `fen` (for move numbers), `onSelectMove?(line, index)`, `depth? nodes? nps? engineName? thinking?`, `maxPvMoves?` |
| `OpeningTree` | `root`, `lines?`, `selectedId?`, `onSelect(node)`, `autoCollapseDepth?` (default 2), `showLineNames?` |
| `ClassificationBadge` | `classification`, `size?` (default 20), `withLabel?` |
| `Modal` | `open`, `onClose`, `title?`, `footer?`, `width?`, `dismissible?` (Esc / backdrop) |
| `Select<T>` | `value`, `options: { value, label, disabled? }[]`, `onChange`, `label?`, `inline?` |
| `Toggle` | `checked`, `onChange`, `label?` |
| `Slider` | `value`, `min`, `max`, `step?`, `onChange`, `label?`, `format?` |
| `Toolbar { align? }`, `ToolbarButton { icon, title, onClick, label?, active?, disabled?, primary? }` | row of board controls |
| `MoveNav` | `ply`, `maxPly`, `onChange(ply)`, `minPly?`, `keyboard?` (Left/Right/Home/End/Up/Down on the window, ignored while typing or when a modal is open), children = extra buttons (flip, autoplay, ...) |
| `Spinner`, `EmptyState { icon?, title, description?, action? }` | |
| `Icon` | `name` (see `IconName`: learn book quiz target analyze search play robot review chart flip first prev next last copy settings sound soundOff close check plus trash refresh info warning external chevronDown chevronRight hint undo flag autoplay pause knight engine brain edit upload star swords) |

`ClassificationBadge.tsx` also exports `CLASSIFICATION_COLORS`, `CLASSIFICATION_LABELS`,
`CLASSIFICATION_GLYPHS` and `KEY_MOMENT_CLASSIFICATIONS`. `api/types.ts` exports
`CLASSIFICATIONS`, `LINE_CATEGORIES` and `LINE_CATEGORY_LABELS` (the Learn "Lines" group names, in
display order).

## Helpers (`src/lib/`)

* `chess.ts`
  * dests and moves: `toDests(chess, { rookCastle? })`, `destsFromFen(fen)`, `isPromotion(fen, from, to)`, `tryMove(fen, from, to, promo?)`, `normalizeCastlingMove`
  * SAN paths: `sanPathToFens(sans, startFen?)` (index i = after i moves), `sanPathToMoves`, `applySanPath` (returns a `Chess`)
  * conversions: `uciToSan(fen, uci)`, `sanToUci(fen, san)`, `uciPathToSans(ucis, fen)` (engine PV to SAN), `normalizeToSans` (mixed UCI/SAN), `parseUci`, `moveToUci`
  * position info: `turnFromFen`, `checkedKingSquare`, `gameStatus(chess)` (`{ over, result, reason }`), `materialInfo(fen)` (captured pieces + material diff)
  * formatting: `moveNumberPrefix(ply)`, `formatSanPath(sans)`, `sansToPgn(sans, { headers, result, startFen })`, `plyOffsetFromFen`
  * constants: `START_FEN`, `PIECE_VALUES`
* `eval.ts`: `winPct(score, pov, fen?)` (0..100, the contract's formula), `formatScore(score, pov?)` ("+1.3", "-0.4", "M3", "-M2", "#"), `evalBarWhiteShare(score, fen?)`, `scoreToCp(score, pov, fen?)` (mate = +-1500, for graphs), `scoreForPov`, `mateWinner`, `moveAccuracy(drop)`. Scores on the wire are **White POV**. `{ mate: 0 }` means checkmate on the board (the side to move in that fen is mated), so pass the fen when you have it.
* `tree.ts`
  * lookups: `findNodeById`, `findNodeByPath`, `deepestNodeOnPath(root, sans)` (for "is this position in our book?"), `pathToNode`, `parentOf`
  * whole-tree: `mainLinePath`, `flattenLines`, `leaves`, `collectNodes`, `walkTree`, `subtreeSize`, `subtreeDepth`
  * lines: `linesEndingAt`, `linesThrough`
  * ids: `nodeIdFromSans`, `sansFromNodeId`
* `sounds.ts`: `playSound('move'|'moveOpponent'|'capture'|'castle'|'check'|'illegal'|'promote'|'gameStart'|'gameEnd')`, `playMoveSound(fenBefore, fenAfter, inCheck, player)`, `setMuted`/`isMuted` (the shell owns the mute flag). Plays `public/sounds/*.mp3` (git-ignored) when present, else synthesised tones.
* `storage.ts`: `loadJson(key, fallback)`, `saveJson(key, value)`, `updateJson(key, fallback, fn)`, `removeKey`. All are wrapped in try/catch.
* `dom.ts`: `scrollIntoViewWithin(el, container)` (scrolls only that container, never the page).

## API client (`src/api/client.ts`)

All functions are typed with `src/api/types.ts`, which mirrors ARCHITECTURE.md. Errors throw
`ApiError` (`status`, `message`, `detail`), where `status === 0` means the backend is unreachable.
Every HTTP function takes an optional `AbortSignal` last, so abort it in your effect cleanup.

```ts
import * as api from '../../api/client'

const openings = await api.listOpenings()                  // OpeningSummary[]
const opening  = await api.getOpening(id)                  // OpeningFull (tree + lines); 404 -> ApiError
const quiz     = await api.getQuiz(id, 'positions', 50)    // QuizItem[] ('positions' | 'traps')
const hint     = await api.analyzeOnce({ fen, multipv: 1, depth: 16 })   // { fen, depth, lines }
const reply    = await api.botMove({ fen, elo: 1500, movetime_ms: 800 }) // { uci, san, fen_after, eval, strength }
const parsed   = await api.parsePgn(pgnText)               // { headers, moves[{san,uci,fen}], startFen }; 400 on bad PGN
const { jobId } = await api.startReview({ moves: sans, depth: 16, players })
const job      = await api.getReview(jobId)                // ReviewJob
const models   = await api.listOllamaModels()              // { models[], default }
const { text } = await api.explainOnce({ jobId, ply, model })
const health   = await api.getHealth()
```

WebSockets (all three were verified against the real backend through the Vite proxy):

```ts
// live analysis: one socket per tab, auto-reconnects and re-sends the last position;
// infos for a fen other than the last one requested are dropped
const sock = api.openAnalysisSocket({ onInfo: (info) => setInfo(info), onStatus: setStatus })
sock.setPosition(fen, multipv)   // call again on every position change (last call wins)
sock.stop()                      // engine off, socket kept
sock.close()                     // in the effect cleanup

// review progress: pushes ReviewJob snapshots, then closes
const rs = api.openReviewSocket(jobId, (job) => setJob(job), async () => {
  setJob(await api.getReview(jobId))   // always fetch the final state once the socket closes
})
rs.close()

// streamed explanation
const es = api.streamExplanation({ jobId, ply, model }, {
  onToken: (t) => setText((s) => s + t),
  onDone: (full) => setText(full),
  onError: (msg) => setError(msg),
})
es.cancel()

// single-move coach (Learn practice): several requests in flight, replies carry requestId;
// verdicts in request order, explanations one at a time. No cancel: close() and open a new socket.
const cs = api.openCoachSocket({
  onAnalysis: (id, move) => {}, onToken: (id, t) => {}, onDone: (id, text) => {},
  onError: (id, stage, msg) => {}, onClose: () => {},   // onClose = lost without close()
})
cs.send({ requestId: 'r1', fen, uci, explain: true, model, context: { studentSide, bookMoves } })
cs.close()
const once = await api.requestCoach({ requestId: '', fen, uci, explain: false })   // POST variant
```

## Opening data and fixtures

The tabs get opening data **only** from the backend (`listOpenings` / `getOpening` / `getQuiz`).
`src/dev/fixtures/alien-gambit.json` is a small 3-line opening file that passes
`tools/validate_opening.py`, and `src/dev/mergeOpening.ts` turns such a file into an `OpeningFull` in
the browser. They power the playground and are fine for local experiments, but never import them
from a tab.
