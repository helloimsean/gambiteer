/**
 * Component playground, served at http://localhost:5173/?dev=1
 * Exercises every shared component with local/fake data; no backend needed.
 * The `data-testid` hooks are used by scripts/check-board.mjs (Playwright smoke test).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Chess } from 'chess.js'
import type { EngineLine, OpeningFile, OpeningNode, Score, Side } from '../api/types'
import { CLASSIFICATIONS } from '../api/types'
import { Board, type BoardShape, type MovableColor } from '../components/Board'
import { ClassificationBadge } from '../components/ClassificationBadge'
import { EmptyState } from '../components/EmptyState'
import { EngineLines } from '../components/EngineLines'
import { EvalBar } from '../components/EvalBar'
import { ICON_NAMES, Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { MoveList } from '../components/MoveList'
import { OpeningTree } from '../components/OpeningTree'
import { Select } from '../components/Select'
import { Slider } from '../components/Slider'
import { Spinner } from '../components/Spinner'
import { Toggle } from '../components/Toggle'
import { MoveNav, ToolbarButton } from '../components/Toolbar'
import { START_FEN, gameStatus, materialInfo, moveToUci, sanPathToFens, type PromotionPiece, type Square } from '../lib/chess'
import { formatScore, winPct } from '../lib/eval'
import { playSound } from '../lib/sounds'
import { mainLinePath } from '../lib/tree'
import { useApp } from '../state/AppContext'
import alienGambit from './fixtures/alien-gambit.json'
import { CASTLING_TEST_FEN, EN_PASSANT_TEST_FEN, FAKE_ENGINE_LINES, FAKE_REVIEW_MOVES, PROMOTION_TEST_FEN } from './fakeData'
import { mergeOpeningFile } from './mergeOpening'
import './DevPlayground.css'

const OPENING = mergeOpeningFile(alienGambit as OpeningFile)
const MAIN_LINE_FENS = [START_FEN, ...mainLinePath(OPENING.tree).map((n) => n.fen)]

/** Minimal linear game model for the playground board. */
function useChessGame(initialFen: string = START_FEN) {
  const [startFen, setStartFen] = useState(initialFen)
  const [sans, setSans] = useState<string[]>([])
  const [ply, setPly] = useState(0)
  const [log, setLog] = useState<string[]>([])

  const { fens, ucis } = useMemo(() => {
    const c = new Chess(startFen)
    const out = [c.fen()]
    const u: string[] = []
    for (const s of sans) {
      u.push(moveToUci(c.move(s)))
      out.push(c.fen())
    }
    return { fens: out, ucis: u }
  }, [startFen, sans])

  const fen = fens[ply] ?? fens[0]

  const move = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece) => {
      const entry = `${from}${to}${promotion ?? ''}`
      const c = new Chess(fen)
      try {
        const m = c.move({ from, to, promotion })
        setSans((cur) => [...cur.slice(0, ply), m.san])
        setPly(ply + 1)
        setLog((l) => [...l.slice(-9), `${entry} ok ${m.san}`])
      } catch {
        playSound('illegal')
        setLog((l) => [...l.slice(-9), `${entry} rejected`])
      }
    },
    [fen, ply],
  )

  const reset = useCallback((newStart: string = START_FEN) => {
    setStartFen(newStart)
    setSans([])
    setPly(0)
  }, [])

  return { fen, fens, sans, ply, setPly, move, reset, lastMove: ply > 0 ? ucis[ply - 1] : null, startFen, log }
}

function BoardSection(): JSX.Element {
  const { settings, setSettings } = useApp()
  const game = useChessGame()
  const [orientation, setOrientation] = useState<Side>('white')
  const [interactive, setInteractive] = useState(true)
  const [movable, setMovable] = useState<MovableColor>('both')
  const [showArrows, setShowArrows] = useState(false)
  const [shake, setShake] = useState(0)
  const [cp, setCp] = useState(35)
  const [mate, setMate] = useState(false)
  const [animation, setAnimation] = useState(true)
  const score: Score = mate ? { mate: cp >= 0 ? 3 : -3 } : { cp }
  const status = gameStatus(new Chess(game.fen))
  const material = materialInfo(game.fen)

  // Rapid fen test: replay the fixture's main line forwards and backwards every 25 ms.
  const [rapidFen, setRapidFen] = useState<string | null>(null)
  const [rapidRuns, setRapidRuns] = useState(0)
  const rapidTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const runRapid = useCallback(() => {
    if (rapidTimer.current) clearInterval(rapidTimer.current)
    const seq = [...MAIN_LINE_FENS, ...MAIN_LINE_FENS.slice(0, -1).reverse(), ...MAIN_LINE_FENS]
    let i = 0
    rapidTimer.current = setInterval(() => {
      if (i >= seq.length) {
        if (rapidTimer.current) clearInterval(rapidTimer.current)
        rapidTimer.current = null
        setRapidRuns((n) => n + 1)
        return
      }
      setRapidFen(seq[i])
      i += 1
    }, 25)
  }, [])
  useEffect(() => () => {
    if (rapidTimer.current) clearInterval(rapidTimer.current)
  }, [])

  const shapes: BoardShape[] = showArrows
    ? [
        { orig: 'e2', dest: 'e4', brush: 'green' },
        { orig: 'd2', dest: 'd4', brush: 'paleBlue' },
        { orig: 'g1', dest: 'f3', brush: 'yellow', label: '2' },
        { orig: 'f7', brush: 'red' },
      ]
    : []

  const boardFen = rapidFen ?? game.fen

  return (
    <section>
      <h2>Board + EvalBar + MoveList</h2>
      <div className="dev-board-row">
        <div className="dev-board-wrap" data-testid="dev-board">
          <EvalBar score={score} orientation={orientation} fen={boardFen} />
          <Board
            fen={boardFen}
            orientation={orientation}
            lastMove={rapidFen ? null : game.lastMove}
            interactive={interactive && !rapidFen}
            movableColor={movable}
            onMove={game.move}
            shapes={shapes}
            coordinates={settings.coordinates}
            animation={animation ? 200 : false}
            shake={shake}
          />
        </div>
        <div className="panel dev-moves-panel">
          <div className="panel-header">
            <span className="panel-title">Moves</span>
            <span className="badge">{game.sans.length} plies</span>
          </div>
          <MoveList
            className="grow"
            moves={game.sans}
            currentPly={game.ply}
            onSelect={game.setPly}
            startPly={0}
            renderBadge={(ply) => {
              const m = FAKE_REVIEW_MOVES[ply - 1]
              return m ? <ClassificationBadge classification={m.classification} size={16} /> : null
            }}
          />
          <div className="panel-footer">
            <div className="btn-group">
              <button className="btn btn-sm btn-icon" onClick={() => game.setPly(0)} title="First">
                <Icon name="first" size={16} />
              </button>
              <button className="btn btn-sm btn-icon" onClick={() => game.setPly(Math.max(0, game.ply - 1))} title="Previous">
                <Icon name="prev" size={16} />
              </button>
              <button className="btn btn-sm btn-icon" onClick={() => game.setPly(Math.min(game.sans.length, game.ply + 1))} title="Next">
                <Icon name="next" size={16} />
              </button>
              <button className="btn btn-sm btn-icon" onClick={() => game.setPly(game.sans.length)} title="Last">
                <Icon name="last" size={16} />
              </button>
            </div>
            <span className="spacer" />
            <button
              className="btn btn-sm btn-icon"
              title="Flip"
              data-testid="dev-flip"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            >
              <Icon name="flip" size={16} />
            </button>
          </div>
        </div>
        <div className="col">
          <div className="row wrap">
            <button className="btn btn-sm" data-testid="dev-reset" onClick={() => game.reset()}>
              New game
            </button>
            <button className="btn btn-sm" data-testid="dev-promo" onClick={() => game.reset(PROMOTION_TEST_FEN)}>
              Promotion test
            </button>
            <button className="btn btn-sm" data-testid="dev-castle" onClick={() => game.reset(CASTLING_TEST_FEN)}>
              Castling test
            </button>
            <button className="btn btn-sm" data-testid="dev-ep" onClick={() => game.reset(EN_PASSANT_TEST_FEN)}>
              En passant test
            </button>
            <button className="btn btn-sm" data-testid="dev-rapid" onClick={runRapid}>
              Rapid fen test
            </button>
            <button className="btn btn-sm" onClick={() => setRapidFen(null)} disabled={!rapidFen}>
              Back to game
            </button>
            <button className="btn btn-sm" onClick={() => setShake((s) => s + 1)}>
              Shake
            </button>
            <button className="btn btn-sm" onClick={() => playSound('illegal')}>
              Illegal sound
            </button>
            <button className="btn btn-sm" onClick={() => playSound('gameEnd')}>
              Game end sound
            </button>
          </div>
          <div className="row wrap gap-12">
            <Toggle checked={interactive} onChange={setInteractive} label="Interactive" />
            <Toggle checked={showArrows} onChange={setShowArrows} label="Arrows" />
            <Toggle checked={animation} onChange={setAnimation} label="Animation" />
            <Toggle checked={settings.coordinates} onChange={(v) => setSettings({ coordinates: v })} label="Coordinates" />
            <Toggle checked={settings.sound} onChange={(v) => setSettings({ sound: v })} label="Sound" />
          </div>
          <Select<MovableColor>
            label="movableColor"
            inline
            value={movable}
            onChange={setMovable}
            options={[
              { value: 'both', label: 'both (side to move)' },
              { value: 'white', label: 'white' },
              { value: 'black', label: 'black' },
              { value: 'none', label: 'none' },
            ]}
          />
          <Slider
            label="Eval (cp, White POV)"
            min={-1500}
            max={1500}
            step={10}
            value={cp}
            onChange={setCp}
            format={(v) => `${formatScore({ cp: v })}  (${winPct({ cp: v }).toFixed(1)}% W)`}
          />
          <Toggle checked={mate} onChange={setMate} label="Mate in 3 (sign from slider)" />
          <pre data-testid="dev-state">
            fen: {boardFen}
            {'\n'}ply: {game.ply} / {game.sans.length} lastMove: {game.lastMove ?? '-'} rapidRuns: {rapidRuns}
            {'\n'}status: {status.over ? `${status.reason} ${status.result}` : 'ongoing'}
            {'\n'}material: diff {material.diff} | W took {material.captured.white.join('') || '-'} | B took{' '}
            {material.captured.black.join('') || '-'}
            {'\n'}onMove log: {game.log.join(' | ') || '-'}
          </pre>
        </div>
      </div>
    </section>
  )
}

/** One Board instance whose props switch between "tab-like" configurations, as when tabs share code. */
function ReuseSection(): JSX.Element {
  const presets = useMemo(
    () => [
      {
        name: 'Learn-like: black, view only, arrows',
        fen: OPENING.lines[0] ? sanPathToFens(OPENING.lines[0].sans).slice(-1)[0] : START_FEN,
        orientation: 'black' as Side,
        interactive: false,
        movable: 'none' as MovableColor,
        shapes: [{ orig: 'e8' as Square, dest: 'g8' as Square, brush: 'paleGreen' as const }],
      },
      {
        name: 'Play-like: white to move, white only',
        fen: START_FEN,
        orientation: 'white' as Side,
        interactive: true,
        movable: 'white' as MovableColor,
        shapes: [],
      },
      {
        name: 'Review-like: mid-game, both arrows',
        fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
        orientation: 'white' as Side,
        interactive: false,
        movable: 'none' as MovableColor,
        shapes: [
          { orig: 'f3' as Square, dest: 'g5' as Square, brush: 'yellow' as const },
          { orig: 'd2' as Square, dest: 'd4' as Square, brush: 'green' as const },
        ],
      },
    ],
    [],
  )
  const [i, setI] = useState(0)
  const [moved, setMoved] = useState<string>('-')
  const p = presets[i % presets.length]
  return (
    <section>
      <h2>Board reuse (one instance, changing props)</h2>
      <div className="dev-tree-row">
        <div data-testid="dev-reuse-board">
          <Board
            fen={p.fen}
            orientation={p.orientation}
            interactive={p.interactive}
            movableColor={p.movable}
            shapes={p.shapes}
            onMove={(from, to, promo) => setMoved(`${from}${to}${promo ?? ''} (not applied)`)}
          />
        </div>
        <div className="col">
          <button className="btn" data-testid="dev-reuse-next" onClick={() => setI((n) => n + 1)}>
            Next preset
          </button>
          <span className="bold">{p.name}</span>
          <span className="muted">last onMove: {moved}. The parent never applies moves here, so a moved piece must snap back.</span>
        </div>
      </div>
    </section>
  )
}

/** The two-column layout the tabs are told to use (README), at a fixed height. */
function WorkspaceSection(): JSX.Element {
  const [ply, setPly] = useState(6)
  const [flipped, setFlipped] = useState(false)
  const sans = OPENING.mainLineSans
  const fens = useMemo(() => sanPathToFens(sans), [sans])
  const fen = fens[ply] ?? START_FEN
  const node = mainLinePath(OPENING.tree)[ply - 1]
  return (
    <section>
      <h2>Workspace layout (.workspace / .board-frame / .workspace-side) + MoveNav (arrow keys)</h2>
      <div className="dev-workspace-host" data-testid="dev-workspace">
        <div className="workspace">
          <div className="workspace-board">
            <div className="board-frame">
              <EvalBar score={{ cp: -120 }} orientation={flipped ? 'black' : 'white'} fen={fen} />
              <Board fen={fen} orientation={flipped ? 'black' : 'white'} lastMove={node?.uci ?? null} interactive={false} />
            </div>
            <MoveNav ply={ply} maxPly={sans.length} onChange={setPly} keyboard>
              <ToolbarButton icon="flip" title="Flip board" onClick={() => setFlipped((f) => !f)} active={flipped} />
            </MoveNav>
          </div>
          <div className="workspace-side">
            <div className="panel grow">
              <div className="panel-tabs">
                <button className="active">Moves</button>
                <button>Engine</button>
              </div>
              <MoveList className="grow" moves={sans} currentPly={ply} onSelect={setPly} />
              <div className="panel-footer">
                <span className="muted">{node ? node.why : 'Start position'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function EngineSection(): JSX.Element {
  const [thinking, setThinking] = useState(false)
  const [last, setLast] = useState<string>('')
  return (
    <section>
      <h2>EngineLines</h2>
      <div className="row">
        <Toggle checked={thinking} onChange={setThinking} label="Thinking" />
        <span className="muted">{last ? `clicked: ${last}` : 'click a PV move'}</span>
      </div>
      <div className="panel" style={{ maxWidth: 720 }}>
        <EngineLines
          lines={FAKE_ENGINE_LINES}
          fen={START_FEN}
          depth={22}
          nodes={12_345_678}
          nps={2_400_000}
          engineName="Stockfish 19"
          thinking={thinking}
          onSelectMove={(line: EngineLine, idx: number) => setLast(`multipv ${line.multipv}: ${line.pv.slice(0, idx + 1).join(' ')}`)}
        />
      </div>
      <div className="panel" style={{ maxWidth: 720 }}>
        <EngineLines lines={[]} fen={START_FEN} />
      </div>
    </section>
  )
}

function TreeSection(): JSX.Element {
  const [selected, setSelected] = useState<OpeningNode | null>(null)
  const fen = selected?.fen ?? START_FEN
  return (
    <section>
      <h2>
        OpeningTree ({OPENING.name}, {OPENING.lineCount} lines)
      </h2>
      <div className="dev-tree-row">
        <div className="col">
          <Board fen={fen} orientation={OPENING.side} lastMove={selected?.uci ?? null} interactive={false} animation={200} />
          <div className="panel">
            <div className="panel-body">
              {selected ? (
                <>
                  <div className="row wrap">
                    <span className="move-san" style={{ fontSize: 20 }}>
                      {Math.ceil(selected.ply / 2)}
                      {selected.ply % 2 ? '.' : '...'}
                      {selected.san}
                      {selected.nag ? <span className="nag">{selected.nag}</span> : null}
                    </span>
                    {selected.mainLine ? <span className="badge badge-green">main line</span> : null}
                    {selected.categories.map((c) => (
                      <span key={c} className="badge">
                        {c}
                      </span>
                    ))}
                  </div>
                  <p className="mt-8">{selected.why || <span className="dim">(no explanation at this node)</span>}</p>
                  <small className="muted">lines: {selected.lineIds.join(', ')}</small>
                </>
              ) : (
                <span className="muted">Click a move in the tree.</span>
              )}
            </div>
          </div>
        </div>
        <div className="panel" style={{ maxHeight: 520 }}>
          <div className="panel-header">
            <span className="panel-title">Tree</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(null)}>
              Reset
            </button>
          </div>
          <OpeningTree
            root={OPENING.tree}
            lines={OPENING.lines}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            autoCollapseDepth={1}
          />
        </div>
      </div>
    </section>
  )
}

function BadgesSection(): JSX.Element {
  return (
    <section>
      <h2>ClassificationBadge</h2>
      <div className="dev-grid" data-testid="dev-badges">
        {CLASSIFICATIONS.map((c) => (
          <div className="dev-badge-cell" key={c}>
            <ClassificationBadge classification={c} size={28} />
            <ClassificationBadge classification={c} size={18} withLabel />
          </div>
        ))}
      </div>
      <h2>Icons</h2>
      <div className="dev-grid">
        {ICON_NAMES.map((n) => (
          <div className="dev-icon-cell" key={n}>
            <Icon name={n} size={22} />
            <span>{n}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function ControlsSection(): JSX.Element {
  const [modal, setModal] = useState(false)
  const [sel, setSel] = useState<'a' | 'b' | 'c'>('a')
  const [tog, setTog] = useState(true)
  const [val, setVal] = useState(1500)
  return (
    <section>
      <h2>Buttons, inputs, badges, Modal, Spinner, EmptyState</h2>
      <div className="dev-grid">
        <button className="btn btn-primary">Primary</button>
        <button className="btn">Default</button>
        <button className="btn btn-ghost">Ghost</button>
        <button className="btn btn-danger">Danger</button>
        <button className="btn btn-sm">Small</button>
        <button className="btn btn-lg btn-primary">Large primary</button>
        <button className="btn" disabled>
          Disabled
        </button>
        <button className="btn btn-icon" title="Copy">
          <Icon name="copy" />
        </button>
        <div className="btn-group">
          <button className="btn btn-sm active">0.3s</button>
          <button className="btn btn-sm">0.8s</button>
          <button className="btn btn-sm">2s</button>
        </div>
        <Spinner />
        <Spinner size={28} />
      </div>
      <div className="dev-grid">
        <span className="badge">default</span>
        <span className="badge badge-white">White</span>
        <span className="badge badge-black">Black</span>
        <span className="badge badge-green">main</span>
        <span className="badge badge-red">trap</span>
        <span className="badge badge-yellow">declined</span>
        <span className="badge badge-blue">accepted</span>
        <span className="badge badge-eco">B15</span>
        <span className="kbd">←</span>
        <span className="kbd">→</span>
        <span className="status-dot ok" /> <span className="status-dot bad" /> <span className="status-dot unknown" />
      </div>
      <div className="dev-controls">
        <Select
          label="Select"
          value={sel}
          options={[
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B' },
            { value: 'c', label: 'Option C (disabled)', disabled: true },
          ]}
          onChange={setSel}
        />
        <Toggle checked={tog} onChange={setTog} label={`Toggle is ${tog ? 'on' : 'off'}`} />
        <Slider
          label="Elo"
          min={400}
          max={3190}
          step={10}
          value={val}
          onChange={setVal}
          format={(v) => `${v} ${v >= 1320 ? '(UCI_Elo)' : '(approx.)'}`}
        />
        <label className="field">
          <span className="field-label">Text input</span>
          <input type="text" placeholder="Paste a FEN" />
        </label>
        <label className="field">
          <span className="field-label">Textarea</span>
          <textarea placeholder="Paste a PGN" />
        </label>
        <div className="progress">
          <span style={{ width: '42%' }} />
        </div>
      </div>
      <div className="row">
        <button className="btn btn-primary" onClick={() => setModal(true)}>
          Open modal
        </button>
      </div>
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Game over"
        footer={
          <>
            <button className="btn" onClick={() => setModal(false)}>
              Rematch
            </button>
            <button className="btn btn-primary" onClick={() => setModal(false)}>
              Review this game
            </button>
          </>
        }
      >
        <p>White wins by checkmate.</p>
        <p className="muted">Esc or clicking the backdrop closes this dialog.</p>
      </Modal>
      <div className="panel" style={{ maxWidth: 520 }}>
        <EmptyState
          icon="robot"
          title="No game yet"
          description="Start a new game to see it here."
          action={<button className="btn btn-primary">New game</button>}
        />
      </div>
    </section>
  )
}

export function DevPlayground(): JSX.Element {
  return (
    <div className="dev">
      <h1>
        <Icon name="knight" size={26} /> Component playground
        <span className="badge">?dev=1</span>
        <span className="spacer" />
        <a className="btn btn-sm" href="/">
          Back to app
        </a>
      </h1>
      <BoardSection />
      <ReuseSection />
      <WorkspaceSection />
      <EngineSection />
      <TreeSection />
      <BadgesSection />
      <ControlsSection />
    </div>
  )
}
