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
import { MoveNav, Toolbar, ToolbarButton } from '../../components/Toolbar'
import { START_FEN, sanPathToFens } from '../../lib/chess'
import { loadJson, removeKey, saveJson } from '../../lib/storage'
import { useApp, type ReviewRequestPayload } from '../../state/AppContext'
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
  reviewPlyOffset,
  type ReviewGame,
  type SavedReviewState,
} from './reviewUtils'
import { useReviewExplain } from './useReviewExplain'
import { useReviewModels } from './useReviewModels'
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

  // restored review (skipped when another tab just handed us a game to review)
  const [saved] = useState<SavedReviewState | null>(() => (reviewRequest ? null : loadSaved()))
  const [source, setSource] = useState<ReviewSource>(() => (lastGame && lastGame.sans.length > 0 ? 'last' : 'pgn'))
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

  const maxPly = result?.moves.length ?? 0
  const goTo = useCallback(
    (p: number) => {
      setPly(Math.max(0, Math.min(maxPly, p)))
      setPanelTab('moves')
    },
    [maxPly],
  )

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
      if (!lastGame || lastGame.sans.length === 0) return
      void runReview(
        { sans: lastGame.sans, startFen: lastGame.startFen, players: lastGame.players, result: lastGame.result, source: 'last' },
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
          source: 'pgn',
        },
        depth,
      )
    } catch (err) {
      if (startTokenRef.current !== token) return
      setError(`Could not read the PGN: ${errorText(err)}`)
      setStarting(false)
    }
  }, [source, lastGame, pgnText, depth, runReview])

  // a game handed over by another tab ("Review this game") starts right away
  const consumedRef = useRef<ReviewRequestPayload | null>(null)
  useEffect(() => {
    if (!reviewRequest || consumedRef.current === reviewRequest) return
    consumedRef.current = reviewRequest
    clearRequest('review')
    if (reviewRequest.sans.length === 0) return
    const sameAsLast = lastGame !== null && lastGame.sans.join(' ') === reviewRequest.sans.join(' ')
    void runReview(
      {
        sans: reviewRequest.sans,
        startFen: reviewRequest.startFen,
        players: reviewRequest.players,
        result: sameAsLast ? lastGame?.result : undefined,
        source: 'request',
      },
      depth,
    )
  }, [reviewRequest, clearRequest, runReview, depth, lastGame])

  const cancelRun = useCallback(() => {
    startTokenRef.current += 1
    setStarting(false)
    setJob(null)
    removeKey(REVIEW_STATE_KEY)
  }, [])

  const newReview = useCallback(() => {
    explain.stop()
    startTokenRef.current += 1
    setJob(null)
    setError(null)
    setPly(0)
    removeKey(REVIEW_STATE_KEY)
  }, [explain])

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
    if (source === 'last' && lastGame && lastGame.sans.length > 0) return safeFens(lastGame.sans, lastGame.startFen)
    return [START_FEN]
  }, [game, starting, active, source, lastGame])

  let fen: string
  let lastMove: string | null = null
  let evalScore: Score | null = null
  const pos = result ? positionAt(result, ply) : null
  if (pos) {
    fen = pos.fen
    lastMove = pos.move?.uci ?? null
    evalScore = pos.score
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

  const canStart = source === 'last' ? Boolean(lastGame && lastGame.sans.length > 0) : pgnText.trim().length > 0

  const flip = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), [])

  const modelPicker = (
    <ReviewModelPicker models={models} value={settings.ollamaModel} onChange={setModel} disabled={run !== null} />
  )

  return (
    <div className="workspace review-tab" data-testid="review-tab" data-phase={result ? 'done' : run ? 'running' : 'setup'}>
      <div className="workspace-board" style={{ '--below-board-h': result ? '140px' : '60px' } as CSSProperties}>
        <div className="board-frame">
          <EvalBar score={evalScore} orientation={orientation} fen={fen} />
          <div className="review-board-wrap">
            <Board fen={fen} orientation={orientation} lastMove={lastMove} interactive={false} coordinates={settings.coordinates} />
            {pos?.move ? (
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
              <MoveNav ply={ply} maxPly={result.moves.length} onChange={goTo} keyboard>
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
            <ReviewAccuracyHeader result={result} players={game?.players} gameResult={game?.result} onNew={newReview} />
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
                    currentPly={ply}
                    onSelect={setPly}
                    startPly={reviewPlyOffset(result)}
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
            lastGame={lastGame}
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
