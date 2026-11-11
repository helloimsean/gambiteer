/**
 * Review tab: Stockfish game review (classification per move, accuracy, eval graph) with an
 * Ollama "coach" that explains moves.
 *
 * Flow: setup (last game / pasted PGN, depth, model) -> POST /api/review -> progress over
 * /ws/review/{jobId} -> report (accuracy header, counts table, eval graph, move list with badges,
 * board with played/best arrows, move details + streamed explanations).
 *
 * The last review (job id, game, result, finished explanations) is kept in localStorage
 * (`review-state-v1`), so switching tabs or reloading does not throw away a finished review, and a
 * review that is still running is picked up again on return.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { ApiError, getReview, openReviewSocket, parsePgn, startReview } from '../../api/client'
import type { ReviewJob, ReviewRequest, Score, Side } from '../../api/types'
import { Board } from '../../components/Board'
import { ClassificationBadge } from '../../components/ClassificationBadge'
import { EvalBar } from '../../components/EvalBar'
import { Icon } from '../../components/Icon'
import { MoveList } from '../../components/MoveList'
import { PgnActions } from '../../components/PgnActions'
import { MoveNav, Toolbar, ToolbarButton } from '../../components/Toolbar'
import { START_FEN, sanPathToFens, type PromotionPiece, type Square } from '../../lib/chess'
import { recordAccuracy, sameMoves } from '../../lib/gameHistory'
import { pgnDate } from '../../lib/pgnTransfer'
import { playSound } from '../../lib/sounds'
import { loadJson, removeKey, saveJson } from '../../lib/storage'
import { useApp, type LastGame, type ReviewRequestPayload } from '../../state/AppContext'
import { ReviewBoardOverlay } from './ReviewBoardOverlay'
import { ReviewDetails } from './ReviewDetails'
import { ReviewEvalGraph } from './ReviewEvalGraph'
import { ReviewModelPicker } from './ReviewModelPicker'
import { ReviewAccuracyHeader, ReviewSummary } from './ReviewReport'
import { ReviewSetup, type ReviewRunInfo, type ReviewSource } from './ReviewSetup'
import {
  REVIEW_STATE_KEY,
  keyMomentPlies,
  playersFromHeaders,
  positionAt,
  reviewFileName,
  reviewPgn,
  reviewPlyOffset,
  type ReviewGame,
  type SavedReviewState,
  sacrificeSound,
} from './reviewUtils'
import { ReviewVariationLine } from './ReviewVariationLine'
import { useReviewExplain } from './useReviewExplain'
import { useReviewModels } from './useReviewModels'
import { useReviewVariation, variationEval } from './useReviewVariation'
import './ReviewTab.css'

type PanelTab = 'summary' | 'moves'

function loadSaved(): SavedReviewState | null {
  const s = loadJson<SavedReviewState | null>(REVIEW_STATE_KEY, null)
  if (!s || typeof s !== 'object' || typeof s.jobId !== 'string' || !s.game || !Array.isArray(s.game.sans)) return null
  if (s.result && !Array.isArray(s.result.moves)) return null
  return s
}

/** Last viewed ply of the saved review (restored after a tab switch). */
const REVIEW_PLY_KEY = 'review-ply-v1'

function savedPly(s: SavedReviewState | null): number {
  if (!s?.result) return 0
  const v = loadJson<{ jobId?: string; ply?: number } | null>(REVIEW_PLY_KEY, null)
  if (!v || v.jobId !== s.jobId || typeof v.ply !== 'number') return 0
  return Math.max(0, Math.min(s.result.moves.length, Math.round(v.ply)))
}

function jobFromSaved(s: SavedReviewState | null): ReviewJob | null {
  if (!s) return null
  return s.result ? { jobId: s.jobId, status: 'done', progress: 1, result: s.result } : { jobId: s.jobId, status: 'queued', progress: 0 }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** The student's side when the game came from Play ("You"), else White. */
function orientationFor(game: ReviewGame | null): Side {
  return game?.players && /^(you|me)$/i.test(game.players.black.trim()) ? 'black' : 'white'
}

function safeFens(sans: readonly string[], startFen?: string): string[] {
  try {
    return sanPathToFens(sans, startFen ?? START_FEN)
  } catch {
    return [startFen ?? START_FEN]
  }
}

export function ReviewTab(): JSX.Element {
  const { lastGame, reviewRequest, clearRequest, settings, setSettings, navigate } = useApp()

  // the game another tab sent here; without one, the setup card offers the last game played
  const [handedGame] = useState<LastGame | null>(() => (reviewRequest && reviewRequest.sans.length > 0 ? reviewRequest : null))
  const selectedGame = handedGame ?? lastGame
  const fromHistory = handedGame !== null && !(lastGame && sameMoves(handedGame, lastGame))

  // restored review (skipped when another tab just handed us a different game)
  const [saved] = useState<SavedReviewState | null>(() => {
    const stored = loadSaved()
    return handedGame && !(stored && sameMoves(stored.game, handedGame)) ? null : stored
  })
  const [source, setSource] = useState<ReviewSource>(() => (selectedGame && selectedGame.sans.length > 0 ? 'last' : 'pgn'))
  const [pgnText, setPgnText] = useState('')
  const [depth, setDepthState] = useState<number>(settings.defaultDepth)
  const [game, setGame] = useState<ReviewGame | null>(() => saved?.game ?? null)
  const [job, setJob] = useState<ReviewJob | null>(() => jobFromSaved(saved))
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ply, setPly] = useState(() => savedPly(saved))
  const [orientation, setOrientation] = useState<Side>(() => orientationFor(saved?.game ?? null))
  const [panelTab, setPanelTab] = useState<PanelTab>(() => (savedPly(saved) > 0 ? 'moves' : 'summary'))
  const [resubscribe, setResubscribe] = useState(0)
  const startTokenRef = useRef(0)

  const models = useReviewModels()
  const effectiveModel = settings.ollamaModel || models.defaultModel

  const result = job?.status === 'done' ? (job.result ?? null) : null
  const jobId = job?.jobId ? job.jobId : null
  const active = jobId !== null && (job?.status === 'queued' || job?.status === 'running')

  // ---------------------------------------------------------------- explanations

  const initialExplanations = useMemo(() => {
    const out: Record<number, string> = {}
    if (result) for (const m of result.moves) if (m.explanation) out[m.ply] = m.explanation
    if (saved && saved.jobId === jobId && saved.explanations) Object.assign(out, saved.explanations)
    return out
  }, [result, saved, jobId])
  const explain = useReviewExplain(result ? jobId : null, settings.ollamaModel, initialExplanations)
  const keyPlies = useMemo(() => (result ? keyMomentPlies(result) : []), [result])

  // ---------------------------------------------------------------- navigation

  const tried = useReviewVariation(result?.depth ?? 0)
  const { variation, clear: clearVariation } = tried

  const maxPly = result?.moves.length ?? 0
  // every way of going to one of the game's moves closes a side line
  const goTo = useCallback(
    (p: number) => {
      clearVariation()
      setPly(Math.max(0, Math.min(maxPly, p)))
      setPanelTab('moves')
    },
    [maxPly, clearVariation],
  )

  // Arriving at a brilliant or great queen or rook sacrifice plays Levy Rozman's voice line. Opening
  // the tab on it, or stepping back onto it from the next move, stays quiet.
  const lastPlyRef = useRef(ply)
  useEffect(() => {
    const previous = lastPlyRef.current
    lastPlyRef.current = ply
    if (!result || ply === previous || ply === previous - 1) return
    const sound = sacrificeSound(result.moves[ply - 1])
    if (sound) playSound(sound)
  }, [ply, result])

  // ---------------------------------------------------------------- starting a review

  const runReview = useCallback(async (g: ReviewGame, d: number) => {
    const token = ++startTokenRef.current
    setError(null)
    setStarting(true)
    setGame(g)
    setJob(null)
    setPly(0)
    setOrientation(orientationFor(g))
    try {
      const req: ReviewRequest = { moves: g.sans, depth: Math.max(4, Math.min(30, Math.round(d))) }
      if (g.startFen && g.startFen !== START_FEN) req.startFen = g.startFen
      if (g.players) req.players = g.players
      const { jobId: id } = await startReview(req)
      if (startTokenRef.current !== token) return
      // saved right away so a tab switch during the run can pick it up again
      saveJson<SavedReviewState>(REVIEW_STATE_KEY, { jobId: id, game: g, savedAt: Date.now() })
      setJob({ jobId: id, status: 'queued', progress: 0 })
    } catch (err) {
      if (startTokenRef.current !== token) return
      setError(`Could not start the review: ${errorText(err)}`)
    } finally {
      if (startTokenRef.current === token) setStarting(false)
    }
  }, [])

  const onStart = useCallback(async () => {
    if (source === 'last') {
      if (!selectedGame || selectedGame.sans.length === 0) return
      void runReview(
        {
          sans: selectedGame.sans,
          startFen: selectedGame.startFen,
          players: selectedGame.players,
          result: selectedGame.result,
          date: pgnDate(new Date(selectedGame.playedAt)),
          source: 'last',
        },
        depth,
      )
      return
    }
    const text = pgnText.trim()
    if (!text) return
    const token = ++startTokenRef.current
    setError(null)
    setStarting(true)
    try {
      const parsed = await parsePgn(text)
      if (startTokenRef.current !== token) return
      if (parsed.moves.length === 0) {
        setError('That PGN has no moves to review.')
        setStarting(false)
        return
      }
      void runReview(
        {
          sans: parsed.moves.map((m) => m.san),
          startFen: parsed.startFen && parsed.startFen !== START_FEN ? parsed.startFen : undefined,
          players: playersFromHeaders(parsed.headers),
          result: parsed.headers.Result,
          date: parsed.headers.Date,
          source: 'pgn',
        },
        depth,
      )
    } catch (err) {
      if (startTokenRef.current !== token) return
      setError(`Could not read the PGN: ${errorText(err)}`)
      setStarting(false)
    }
  }, [source, selectedGame, pgnText, depth, runReview])

  // A game sent from another tab waits on the setup card until Game Review is pressed, to allow
  // picking a depth first. Reopening the game that was just reviewed shows its report instead.
  const consumedRef = useRef<ReviewRequestPayload | null>(null)
  useEffect(() => {
    if (!reviewRequest || consumedRef.current === reviewRequest) return
    consumedRef.current = reviewRequest
    clearRequest('review')
    if (handedGame && !saved) removeKey(REVIEW_STATE_KEY) // or an older report would replace this setup after a tab switch
  }, [reviewRequest, clearRequest, handedGame, saved])

  const cancelRun = useCallback(() => {
    startTokenRef.current += 1
    setStarting(false)
    setJob(null)
    removeKey(REVIEW_STATE_KEY)
  }, [])

  const newReview = useCallback(() => {
    explain.stop()
    clearVariation()
    startTokenRef.current += 1
    setJob(null)
    setError(null)
    setPly(0)
    removeKey(REVIEW_STATE_KEY)
  }, [explain, clearVariation])

  // ---------------------------------------------------------------- progress socket

  // Applies a job snapshot and handles the status transitions: finished -> report (from the
  // start, Summary tab); failed -> back to the setup card with the message.
  const statusRef = useRef(job?.status)
  useEffect(() => {
    statusRef.current = job?.status
  })
  const applySnapshot = useCallback((snap: ReviewJob) => {
    if (snap.status === 'error') {
      statusRef.current = undefined
      setError(`The review failed: ${snap.message ?? 'unknown error'}`)
      setJob(null)
      removeKey(REVIEW_STATE_KEY)
      return
    }
    if (snap.status === 'done' && statusRef.current !== 'done') {
      setPly(0)
      setPanelTab('summary')
    }
    statusRef.current = snap.status
    setJob(snap)
  }, [])

  useEffect(() => {
    if (!active || !jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const sock = openReviewSocket(
      jobId,
      (snap) => {
        if (!cancelled) applySnapshot(snap)
      },
      () => {
        if (cancelled) return
        // the socket closes after the final snapshot (or on a hiccup): fetch the real state once
        getReview(jobId)
          .then((final) => {
            if (cancelled) return
            applySnapshot(final)
            if (final.status === 'queued' || final.status === 'running') {
              timer = setTimeout(() => setResubscribe((n) => n + 1), 800)
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return
            if (err instanceof ApiError && err.status === 404) {
              setJob(null)
              removeKey(REVIEW_STATE_KEY)
              setError('That review is no longer on the server (the backend was restarted). Please start it again.')
            } else {
              timer = setTimeout(() => setResubscribe((n) => n + 1), 2000)
            }
          })
      },
    )
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      sock.close()
    }
  }, [active, jobId, resubscribe, applySnapshot])

  // persist the finished review with its explanations
  const doneKey = useMemo(
    () =>
      Object.entries(explain.entries)
        .filter(([, e]) => e.status === 'done')
        .map(([k, e]) => `${k}:${e.text.length}`)
        .join(','),
    [explain.entries],
  )
  const entriesRef = useRef(explain.entries)
  useEffect(() => {
    entriesRef.current = explain.entries
  })
  useEffect(() => {
    if (!result || !jobId || !game) return
    const explanations: Record<number, string> = {}
    for (const [k, e] of Object.entries(entriesRef.current)) if (e.status === 'done' && e.text) explanations[Number(k)] = e.text
    saveJson<SavedReviewState>(REVIEW_STATE_KEY, { jobId, game, result, explanations, savedAt: Date.now() })
  }, [result, jobId, game, doneKey])

  // the accuracy shows up in History once a game has been reviewed
  useEffect(() => {
    if (result && game) recordAccuracy(game, result.accuracy)
  }, [result, game])

  // remember the viewed ply of a finished review
  useEffect(() => {
    if (result && jobId) saveJson(REVIEW_PLY_KEY, { jobId, ply })
  }, [result, jobId, ply])

  // ---------------------------------------------------------------- settings

  const setDepth = useCallback(
    (d: number) => {
      setDepthState(d)
      if (d >= 12 && d <= 24) setSettings({ defaultDepth: d })
    },
    [setSettings],
  )
  const setModel = useCallback((m: string) => setSettings({ ollamaModel: m }), [setSettings])

  const explainAll = useCallback(() => {
    explain.explainAll(keyPlies, (p) => goTo(p))
  }, [explain, keyPlies, goTo])

  // ---------------------------------------------------------------- board state

  const previewFens = useMemo(() => {
    if (game && (starting || active)) return safeFens(game.sans, game.startFen)
    if (source === 'last' && selectedGame && selectedGame.sans.length > 0) return safeFens(selectedGame.sans, selectedGame.startFen)
    return [START_FEN]
  }, [game, starting, active, source, selectedGame])

  let fen: string
  let lastMove: string | null = null
  let evalScore: Score | null = null
  const pos = result ? positionAt(result, ply) : null
  const triedMove = variation ? variation.moves[variation.index - 1] : null
  if (pos) {
    fen = triedMove?.fenAfter ?? pos.fen
    lastMove = triedMove?.uci ?? pos.move?.uci ?? null
    evalScore = variation ? variationEval(variation, pos.score) : pos.score
  } else if (active && job) {
    const n = previewFens.length - 1
    fen = previewFens[Math.min(n, Math.round(job.progress * n))] ?? START_FEN
  } else {
    fen = previewFens[previewFens.length - 1] ?? START_FEN
  }

  const run: ReviewRunInfo | null = starting
    ? { status: 'starting', progress: 0, totalPlies: game?.sans.length ?? 0 }
    : active && job
      ? {
          status: job.status === 'running' ? 'running' : 'queued',
          progress: job.progress,
          message: job.message,
          totalPlies: game?.sans.length ?? 0,
        }
      : null

  const canStart = source === 'last' ? Boolean(selectedGame && selectedGame.sans.length > 0) : pgnText.trim().length > 0

  const flip = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), [])

  const onBoardMove = (from: Square, to: Square, promotion?: PromotionPiece) => {
    if (!result) return
    const uci = `${from}${to}${promotion ?? ''}`
    setPanelTab('moves')
    if (variation) {
      tried.play({ fenBefore: fen, basePly: variation.basePly, keep: variation.index, uci })
      return
    }
    const next = result.moves[ply]
    if (next?.uci === uci) {
      goTo(ply + 1) // the move the game went on with: nothing new to try
      return
    }
    tried.play({ fenBefore: fen, basePly: ply, keep: 0, uci, knownBest: next?.bestMove.uci === uci })
  }

  /** Replaces the move on show with the best move the panel names for it. */
  const playBest = () => {
    if (variation && triedMove?.verdict) {
      tried.play({
        fenBefore: triedMove.fenBefore,
        basePly: variation.basePly,
        keep: variation.index - 1,
        uci: triedMove.verdict.bestMove.uci,
        knownBest: true,
      })
    } else if (pos?.move) {
      setPly(ply - 1)
      tried.play({ fenBefore: pos.move.fenBefore, basePly: ply - 1, keep: 0, uci: pos.move.bestMove.uci, knownBest: true })
    }
  }

  const navPly = variation ? variation.basePly + variation.index : ply
  const navMax = variation ? variation.basePly + variation.moves.length : maxPly
  const navTo = (p: number) => {
    if (variation && p > variation.basePly) tried.select(p - variation.basePly)
    else goTo(p)
  }
  const plyOffset = result ? reviewPlyOffset(result) : 0

  const modelPicker = (
    <ReviewModelPicker models={models} value={settings.ollamaModel} onChange={setModel} disabled={run !== null} />
  )

  return (
    <div className="workspace review-tab" data-testid="review-tab" data-phase={result ? 'done' : run ? 'running' : 'setup'}>
      <div className="workspace-board" style={{ '--below-board-h': result ? '140px' : '60px' } as CSSProperties}>
        <div className="board-frame">
          <EvalBar score={evalScore} orientation={orientation} fen={fen} />
          <div className="review-board-wrap">
            <Board
              fen={fen}
              orientation={orientation}
              lastMove={lastMove}
              interactive={result !== null}
              onMove={onBoardMove}
              coordinates={settings.coordinates}
            />
            {triedMove ? (
              triedMove.verdict ? (
                <ReviewBoardOverlay
                  orientation={orientation}
                  playedUci={triedMove.uci}
                  classification={triedMove.verdict.classification}
                  bestUci={triedMove.verdict.bestMove.uci}
                  animKey={`tried-${triedMove.id}`}
                />
              ) : null
            ) : pos?.move ? (
              <ReviewBoardOverlay
                orientation={orientation}
                playedUci={pos.move.uci}
                classification={pos.move.classification}
                bestUci={pos.move.bestMove.uci}
                animKey={ply}
              />
            ) : null}
          </div>
        </div>
        <div className="review-below">
          {result ? (
            <>
              <ReviewEvalGraph result={result} ply={ply} onSelect={goTo} />
              <MoveNav ply={navPly} maxPly={navMax} onChange={navTo} keyboard>
                <ToolbarButton icon="flip" title="Flip board" onClick={flip} />
                <ToolbarButton icon="analyze" title="Open this position in Analyze" onClick={() => navigate('analyze', { fen })} />
              </MoveNav>
            </>
          ) : (
            <Toolbar>
              <ToolbarButton icon="flip" title="Flip board" onClick={flip} />
            </Toolbar>
          )}
        </div>
      </div>

      <div className="workspace-side">
        {result && job ? (
          <>
            <ReviewAccuracyHeader
              result={result}
              players={game?.players}
              gameResult={game?.result}
              onNew={newReview}
              actions={game ? <PgnActions getPgn={() => reviewPgn(game)} fileName={reviewFileName(game)} /> : undefined}
            />
            <div className="panel grow review-main">
              <div className="panel-tabs">
                <button type="button" className={panelTab === 'summary' ? 'active' : ''} onClick={() => setPanelTab('summary')} data-testid="review-tab-summary">
                  Summary
                </button>
                <button type="button" className={panelTab === 'moves' ? 'active' : ''} onClick={() => setPanelTab('moves')} data-testid="review-tab-moves">
                  Moves
                </button>
              </div>
              {panelTab === 'summary' ? (
                <>
                  <div className="panel-body scroll grow">
                    <ReviewSummary result={result} players={game?.players} onJump={goTo} ply={ply} />
                  </div>
                  <div className="panel-footer">
                    <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => goTo(Math.max(1, ply))} data-testid="review-start-moves">
                      <Icon name="next" size={18} /> {ply > 0 ? 'Back to the moves' : 'Step through the moves'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="review-moves-pane">
                  <ReviewDetails
                    result={result}
                    ply={ply}
                    tried={variation && triedMove ? { move: triedMove, absPly: plyOffset + variation.basePly + variation.index } : null}
                    onPlayBest={playBest}
                    onRetryTried={tried.retry}
                    players={game?.players}
                    explain={explain}
                    models={models}
                    modelValue={settings.ollamaModel}
                    onModel={setModel}
                    effectiveModel={effectiveModel}
                    keyPlies={keyPlies}
                    onExplainAll={explainAll}
                    onJump={goTo}
                  />
                  <MoveList
                    className="review-movelist"
                    moves={result.moves.map((m) => m.san)}
                    currentPly={variation ? -1 : ply}
                    onSelect={goTo}
                    startPly={plyOffset}
                    insert={
                      variation
                        ? {
                            afterPly: Math.min(variation.basePly + 1, result.moves.length),
                            node: <ReviewVariationLine variation={variation} startPly={plyOffset + variation.basePly} onSelect={tried.select} />,
                          }
                        : undefined
                    }
                    renderBadge={(p) => {
                      const m = result.moves[p - 1]
                      return m ? <ClassificationBadge classification={m.classification} size={15} /> : null
                    }}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <ReviewSetup
            source={source}
            onSource={setSource}
            selectedGame={selectedGame}
            selectedLabel={fromHistory ? 'History game' : 'Last game'}
            pgnText={pgnText}
            onPgnText={setPgnText}
            depth={depth}
            onDepth={setDepth}
            modelPicker={modelPicker}
            run={run}
            error={error}
            canStart={canStart && run === null}
            onStart={() => void onStart()}
            onCancel={cancelRun}
          />
        )}
      </div>
    </div>
  )
}
