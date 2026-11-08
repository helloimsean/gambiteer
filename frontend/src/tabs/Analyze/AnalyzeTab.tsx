/**
 * Analyze tab: free analysis board with live Stockfish lines.
 *
 * - Free moves for both sides on a linear history (playing a different move at an earlier ply
 *   replaces the moves after it; "Undo to here" cuts the history at the current move).
 * - Engine on/off (default on), MultiPV 1-5, live lines from /ws/analyze, eval bar, best-move
 *   arrow (green) and second best (pale green), depth / nodes / nps.
 * - FEN / PGN import, "Set up position" (editable FEN), copy FEN / PGN, flip.
 * - "Opening" label with the `why` of the move when the SAN path from the initial position is in
 *   one of our openings.
 * - Consumes `analyzeRequest` ({ fen } or { sans, startFen? }) from AppContext.
 *
 * The board state (start fen, moves, current ply, orientation) is kept in localStorage
 * (`analyze-state-v1`) so it survives tab switches and reloads; the MultiPV choice in
 * `analyze-multipv-v1`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AnalyzeRequestPayload } from '../../state/AppContext'
import { useApp } from '../../state/AppContext'
import type { Side } from '../../api/types'
import { Board, type BoardShape } from '../../components/Board'
import { EvalBar } from '../../components/EvalBar'
import { MoveList } from '../../components/MoveList'
import { EngineLines } from '../../components/EngineLines'
import { MoveNav, ToolbarButton } from '../../components/Toolbar'
import { Toggle } from '../../components/Toggle'
import { Select } from '../../components/Select'
import { Icon } from '../../components/Icon'
import {
  START_FEN,
  applySanPath,
  gameStatus,
  normalizeToSans,
  parseUci,
  plyOffsetFromFen,
  sansToPgn,
  tryMove,
  type PromotionPiece,
  type Square,
} from '../../lib/chess'
import { copyText, downloadPgn, pgnDate, pgnFileName } from '../../lib/pgnTransfer'
import { playSound } from '../../lib/sounds'
import { loadJson, saveJson } from '../../lib/storage'
import { useAnalyzeEngine } from './useAnalyzeEngine'
import { useAnalyzeOpenings } from './useAnalyzeOpenings'
import { AnalyzeOpeningLabel } from './AnalyzeOpeningLabel'
import { AnalyzeImport, AnalyzeSetup } from './AnalyzeImportPanel'
import {
  buildLine,
  isInitialPosition,
  normalizeFen,
  type AnalyzeLine,
  type ParsedGame,
} from './analyzeHelpers'
import './AnalyzeTab.css'

const STATE_KEY = 'analyze-state-v1'
const MULTIPV_KEY = 'analyze-multipv-v1'
const MULTIPV_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))

interface LineState extends AnalyzeLine {
  /** 0..sans.length; 0 = start position. */
  ply: number
}

interface SavedState extends LineState {
  orientation: Side
}

type SideTab = 'moves' | 'import' | 'setup'

const INITIAL_LINE: LineState = { startFen: START_FEN, sans: [], ply: 0 }

/** A request from another tab as a line, or an error message. */
function lineFromRequest(req: AnalyzeRequestPayload): { line: LineState } | { error: string } {
  if (req.fen) {
    const res = normalizeFen(req.fen)
    if ('error' in res) return { error: `Could not open that position: ${res.error}` }
    return { line: { startFen: res.fen, sans: [], ply: 0 } }
  }
  if (req.sans) {
    let startFen = START_FEN
    if (req.startFen) {
      const res = normalizeFen(req.startFen)
      if ('error' in res) return { error: `Could not open that position: ${res.error}` }
      startFen = res.fen
    }
    try {
      const sans = normalizeToSans(req.sans, startFen) // accepts UCI too
      buildLine({ startFen, sans })
      return { line: { startFen, sans, ply: sans.length } }
    } catch (err) {
      return { error: `Could not open those moves: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { error: 'Nothing to analyse in that request.' }
}

function loadSaved(): SavedState {
  const s = loadJson<Partial<SavedState> | null>(STATE_KEY, null)
  const orientation: Side = s?.orientation === 'black' ? 'black' : 'white'
  if (!s || typeof s.startFen !== 'string' || !Array.isArray(s.sans)) return { ...INITIAL_LINE, orientation }
  try {
    const sans = s.sans.filter((x): x is string => typeof x === 'string')
    const { fens } = buildLine({ startFen: s.startFen, sans })
    const ply = typeof s.ply === 'number' ? Math.max(0, Math.min(sans.length, Math.floor(s.ply))) : sans.length
    return { startFen: fens[0], sans, ply, orientation }
  } catch {
    return { ...INITIAL_LINE, orientation }
  }
}

function loadMultipv(): number {
  const n = Number(loadJson<number>(MULTIPV_KEY, 3))
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3
}

function statusText(over: ReturnType<typeof gameStatus>): string | null {
  if (!over.over) return null
  switch (over.reason) {
    case 'checkmate':
      return `Checkmate, ${over.result === '1-0' ? 'White' : 'Black'} wins`
    case 'stalemate':
      return 'Stalemate (draw)'
    case 'insufficient':
      return 'Draw by insufficient material'
    case 'threefold':
      return 'Draw by threefold repetition'
    case 'fifty-move':
      return 'Draw by the fifty-move rule'
    default:
      return 'Draw'
  }
}

export function AnalyzeTab(): JSX.Element {
  const { analyzeRequest, clearRequest, settings, health, navigate } = useApp()

  // ------------------------------------------------------------ board state
  // Initial board: a pending request from another tab wins over the saved board.
  const [boot] = useState(() => {
    const saved = loadSaved()
    const savedLine: LineState = { startFen: saved.startFen, sans: saved.sans, ply: saved.ply }
    if (analyzeRequest) {
      const res = lineFromRequest(analyzeRequest)
      if ('line' in res) return { line: res.line, orientation: saved.orientation, consumed: analyzeRequest }
    }
    return { line: savedLine, orientation: saved.orientation, consumed: null }
  })
  /** The request already applied (so the effect below only clears it). */
  const consumedRef = useRef<AnalyzeRequestPayload | null>(boot.consumed)
  const [line, setLine] = useState<LineState>(boot.line)
  const [orientation, setOrientation] = useState<Side>(boot.orientation)
  const [imported, setImported] = useState<{ headers: Record<string, string>; key: string } | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('moves')

  // requests from other tabs ("Analyze this position")
  useEffect(() => {
    if (!analyzeRequest) return
    if (analyzeRequest !== consumedRef.current) {
      const res = lineFromRequest(analyzeRequest)
      if ('line' in res) {
        setLine(res.line)
        setImported(null)
        setBanner(null)
      } else {
        setBanner(res.error)
      }
    }
    consumedRef.current = analyzeRequest
    clearRequest('analyze')
  }, [analyzeRequest, clearRequest])

  // remember the board between visits
  useEffect(() => {
    saveJson<SavedState>(STATE_KEY, { ...line, orientation })
  }, [line, orientation])

  // every setLine is validated first, so `built` is only null for a state that cannot happen
  const built = useMemo(() => {
    try {
      return buildLine(line)
    } catch {
      return null
    }
  }, [line])

  const fen = built ? built.fens[Math.min(line.ply, built.fens.length - 1)] : START_FEN
  const lastMove = built && line.ply > 0 ? built.ucis[line.ply - 1] : null
  const status = useMemo(() => {
    try {
      return gameStatus(applySanPath(line.sans.slice(0, line.ply), line.startFen))
    } catch {
      return { over: false } as const
    }
  }, [line])

  // ------------------------------------------------------------ engine
  const [engineOn, setEngineOn] = useState(true)
  const [multipv, setMultipv] = useState<number>(loadMultipv)
  useEffect(() => {
    saveJson(MULTIPV_KEY, multipv)
  }, [multipv])
  const engine = useAnalyzeEngine(fen, multipv, engineOn)
  const engineLines = useMemo(
    () => (engine.info ? [...engine.info.lines].sort((a, b) => a.multipv - b.multipv) : []),
    [engine.info],
  )
  const bestLine = engineLines.find((l) => l.multipv === 1) ?? null
  const secondLine = engineLines.find((l) => l.multipv === 2) ?? null
  const score = bestLine?.score ?? null

  const bestUci = bestLine?.pvUci[0] ?? ''
  const secondUci = multipv >= 2 ? (secondLine?.pvUci[0] ?? '') : ''
  const shapes = useMemo<BoardShape[]>(() => {
    const out: BoardShape[] = []
    const arrow = (uci: string, brush: BoardShape['brush']) => {
      if (uci.length < 4) return
      const { from, to } = parseUci(uci)
      out.push({ orig: from, dest: to, brush })
    }
    arrow(secondUci, 'paleGreen') // drawn first so the best arrow sits on top
    arrow(bestUci, 'green')
    return out
  }, [bestUci, secondUci])

  // ------------------------------------------------------------ opening book
  const bookPath = useMemo(
    () => (isInitialPosition(line.startFen) ? line.sans.slice(0, line.ply) : null),
    [line],
  )
  const openings = useAnalyzeOpenings(bookPath)

  // ------------------------------------------------------------ actions
  /** Play a SAN sequence from the current ply (keeps the existing continuation when it matches). */
  const playSans = useCallback((seq: readonly string[]) => {
    setLine((prev) => {
      let sans = prev.sans
      let ply = prev.ply
      for (const san of seq) {
        if (sans[ply] === san) {
          ply += 1
          continue
        }
        sans = [...sans.slice(0, ply), san]
        ply += 1
      }
      try {
        buildLine({ startFen: prev.startFen, sans })
      } catch {
        return prev
      }
      return { startFen: prev.startFen, sans, ply }
    })
  }, [])

  const onBoardMove = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece) => {
      const mv = tryMove(fen, from, to, promotion)
      if (!mv) {
        playSound('illegal')
        return
      }
      playSans([mv.san])
    },
    [fen, playSans],
  )

  const setPly = useCallback((ply: number) => {
    setLine((prev) => ({ ...prev, ply: Math.max(0, Math.min(prev.sans.length, ply)) }))
  }, [])

  const takeBack = () =>
    setLine((prev) => (prev.ply === 0 ? prev : { ...prev, sans: prev.sans.slice(0, prev.ply - 1), ply: prev.ply - 1 }))
  const undoToHere = () => setLine((prev) => ({ ...prev, sans: prev.sans.slice(0, prev.ply) }))

  const loadFen = useCallback((newFen: string) => {
    setLine({ startFen: newFen, sans: [], ply: 0 })
    setImported(null)
    setBanner(null)
  }, [])

  const loadGame = useCallback((game: ParsedGame) => {
    const res = normalizeFen(game.startFen)
    const startFen = 'fen' in res ? res.fen : START_FEN
    try {
      buildLine({ startFen, sans: game.sans })
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err))
      return
    }
    setLine({ startFen, sans: game.sans, ply: game.sans.length })
    setImported({ headers: game.headers, key: `${startFen}|${game.sans.join(' ')}` })
    setBanner(null)
  }, [])

  // ------------------------------------------------------------ copy
  const [copied, setCopied] = useState<'fen' | 'pgn' | 'failed' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const buildPgn = (): string => {
    let result = '*'
    try {
      const final = gameStatus(applySanPath(line.sans, line.startFen))
      if (final.over) result = final.result
    } catch {
      /* keep "*" */
    }
    const sameGame = imported !== null && imported.key === `${line.startFen}|${line.sans.join(' ')}`
    const fromImport = { ...(imported?.headers ?? {}) }
    delete fromImport.FEN
    delete fromImport.SetUp
    if (result === '*' && sameGame && fromImport.Result) result = fromImport.Result
    delete fromImport.Result
    const headers: Record<string, string> = {
      Event: 'Analysis',
      Site: 'Gambiteer',
      Date: pgnDate(),
      White: '?',
      Black: '?',
      ...fromImport,
      Result: result,
    }
    return sansToPgn(line.sans, { headers, result, startFen: line.startFen })
  }

  const copy = async (what: 'fen' | 'pgn') => {
    const ok = await copyText(what === 'fen' ? fen : buildPgn())
    setCopied(ok ? what : 'failed')
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(null), 1800)
  }

  // ------------------------------------------------------------ render
  const engineName = health?.stockfish?.name || 'Stockfish'
  const dot = engine.status === 'open' ? 'ok' : engine.status === 'reconnecting' ? 'bad' : 'unknown'
  const dotTitle =
    engine.status === 'open'
      ? 'Connected to the analysis engine'
      : engine.status === 'reconnecting'
        ? 'Engine connection lost, reconnecting…'
        : 'Connecting to the analysis engine…'
  const waiting = engineOn && !engine.info
  const emptyText = !engineOn
    ? 'Engine is off'
    : engine.status === 'reconnecting'
      ? 'Engine connection lost, reconnecting…'
      : engine.status === 'connecting'
        ? 'Connecting to the engine…'
        : 'Analysing…'
  const over = statusText(status)
  const startPly = plyOffsetFromFen(line.startFen)

  return (
    <div className="workspace analyze-tab" data-testid="analyze-tab">
      <div className="workspace-board">
        <div className="board-frame" data-testid="analyze-board">
          <EvalBar score={score} orientation={orientation} fen={fen} />
          <Board
            fen={fen}
            orientation={orientation}
            lastMove={lastMove}
            onMove={onBoardMove}
            movableColor="both"
            shapes={shapes}
            coordinates={settings.coordinates}
          />
        </div>
        <MoveNav ply={line.ply} maxPly={line.sans.length} onChange={setPly} keyboard className="analyze-toolbar">
          <span className="analyze-toolbar-sep" />
          <ToolbarButton
            icon="flip"
            title="Flip board"
            onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            active={orientation === 'black'}
          />
          <ToolbarButton icon="undo" title="Take back the current move" onClick={takeBack} disabled={line.ply === 0} />
          <ToolbarButton
            icon="trash"
            title="Undo to here (delete the moves after the current one)"
            onClick={undoToHere}
            disabled={line.ply >= line.sans.length}
          />
          <ToolbarButton icon="refresh" title="New analysis from the initial position" onClick={() => loadFen(START_FEN)} />
        </MoveNav>
      </div>

      <div className="workspace-side analyze-side">
        {banner ? (
          <div className="analyze-banner" role="alert">
            <Icon name="warning" size={16} />
            <span className="grow">{banner}</span>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Dismiss" onClick={() => setBanner(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}

        <div className="panel analyze-engine" data-testid="analyze-engine">
          <div className="panel-header analyze-engine-header">
            <span className={`status-dot ${dot}`} title={dotTitle} data-testid="analyze-engine-status" data-status={engine.status} />
            <Icon name="engine" size={16} />
            <span className="panel-title truncate" title={engineName}>
              {engineName}
            </span>
            <Select
              inline
              label="Lines"
              value={String(multipv)}
              options={MULTIPV_OPTIONS}
              onChange={(v) => setMultipv(Number(v))}
              className="analyze-multipv"
              title="Number of engine lines (MultiPV)"
            />
            <Toggle checked={engineOn} onChange={setEngineOn} label="Engine" title="Engine on/off" className="analyze-engine-toggle" />
          </div>
          {over ? (
            <div className="analyze-gameover" data-testid="analyze-gameover">
              <Icon name="flag" size={14} /> {over}
            </div>
          ) : null}
          <EngineLines
            className="analyze-engine-lines"
            lines={engineLines}
            fen={fen}
            onSelectMove={(l, i) => playSans(l.pv.slice(0, i + 1))}
            depth={engine.info ? engine.info.depth : undefined}
            nodes={engine.info ? engine.info.nodes : undefined}
            nps={engine.info ? engine.info.nps : undefined}
            thinking={waiting}
            emptyText={emptyText}
            maxPvMoves={10}
          />
        </div>

        <AnalyzeOpeningLabel
          state={openings}
          sans={bookPath}
          onOpenLearn={(openingId, nodeId) => navigate('learn', { openingId, nodeId })}
        />

        <div className="panel grow analyze-main-panel">
          <div className="panel-tabs" role="tablist">
            {(
              [
                ['moves', 'Moves'],
                ['import', 'Import PGN'],
                ['setup', 'Set up position'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sideTab === id}
                className={sideTab === id ? 'active' : ''}
                onClick={() => setSideTab(id)}
                data-testid={`analyze-tab-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="analyze-panel-body">
            {sideTab === 'moves' ? (
              <MoveList
                className="analyze-movelist"
                moves={line.sans}
                currentPly={line.ply}
                onSelect={setPly}
                startPly={startPly}
                emptyText="Make a move on the board, or load a FEN / PGN."
              />
            ) : sideTab === 'import' ? (
              <AnalyzeImport
                onLoadFen={(f) => {
                  loadFen(f)
                }}
                onLoadGame={loadGame}
              />
            ) : (
              <AnalyzeSetup fen={fen} onLoadFen={loadFen} onCopyFen={() => void copy('fen')} />
            )}
          </div>
          <div className="panel-footer analyze-footer">
            <button type="button" className="btn btn-sm" onClick={() => void copy('fen')} data-testid="analyze-copy-fen">
              <Icon name="copy" size={15} /> Copy FEN
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void copy('pgn')} data-testid="analyze-copy-pgn">
              <Icon name="copy" size={15} /> Copy PGN
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="Download this game as a .pgn file"
              onClick={() => downloadPgn(buildPgn(), pgnFileName(`analysis ${pgnDate()}`))}
              data-testid="analyze-download-pgn"
            >
              <Icon name="download" size={15} /> Download
            </button>
            <span className="spacer" />
            {copied ? (
              <span className={`analyze-copied ${copied === 'failed' ? 'failed' : ''}`} data-testid="analyze-copied">
                {copied === 'failed' ? 'Copy failed' : copied === 'fen' ? 'FEN copied' : 'PGN copied'}
              </span>
            ) : (
              <span className="dim small">
                {line.sans.length > 0 ? `${line.ply}/${line.sans.length}` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
