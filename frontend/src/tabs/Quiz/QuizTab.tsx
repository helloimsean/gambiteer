/**
 * Quiz tab (ARCHITECTURE.md > Frontend > Tabs > Quiz).
 *
 * Modes: Line drill (play a whole line, the app answers from the line), Position quiz (random
 * repertoire positions, any book child is right) and Traps (punish the opponent's mistake to the
 * end of the trap line). Progress per position lives in localStorage (`quiz-stats-v1`) and weak
 * positions are asked first. Consumes `quizRequest` ({ openingId, lineId?, mode? }).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import * as api from '../../api/client'
import type { OpeningFull, OpeningSummary, QuizItem } from '../../api/types'
import { Board } from '../../components/Board'
import { EmptyState } from '../../components/EmptyState'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { START_FEN } from '../../lib/chess'
import { nodeIdFromSans } from '../../lib/tree'
import { useApp } from '../../state/AppContext'
import { QuizExercise } from './QuizExercise'
import { QuizSettingsPanel, QuizStatsPanel } from './QuizPanels'
import { EMPTY_SESSION, loadQuizStats, recordQuizResult, resetQuizStats, type QuizSession, type QuizStats } from './QuizStats'
import {
  RANDOM_LINE,
  buildItemTask,
  buildLineGroups,
  buildLineTask,
  itemKey,
  lineKey,
  parseLineKey,
  pickItem,
  pickRandomLine,
  restartTask,
  type LineCandidate,
  type QuizMode,
  type QuizTask,
  withTranspositions,
} from './QuizTasks'
import './QuizTab.css'

/** Ask the backend for every quiz item so the stats-based weighting sees the whole pool. */
const ITEM_LIMIT = 5000

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function QuizTab(): JSX.Element {
  const { quizRequest, clearRequest, settings, navigate } = useApp()

  const [openings, setOpenings] = useState<OpeningSummary[] | null>(null)
  const [openingsError, setOpeningsError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [selected, setSelected] = useState<string[]>(() => (quizRequest ? [quizRequest.openingId] : []))
  const [mode, setMode] = useState<QuizMode>(() => quizRequest?.mode ?? 'line')
  const [lineChoice, setLineChoice] = useState<string>(() =>
    quizRequest?.lineId ? lineKey(quizRequest.openingId, quizRequest.lineId) : RANDOM_LINE,
  )

  const [fulls, setFulls] = useState<Record<string, OpeningFull>>({})
  const fullsRef = useRef<Record<string, OpeningFull>>({})
  const [itemsCache, setItemsCache] = useState<Record<string, QuizItem[]>>({})
  const itemsRef = useRef<Record<string, QuizItem[]>>({})
  const [dataError, setDataError] = useState<string | null>(null)

  const [stats, setStats] = useState<QuizStats>(loadQuizStats)
  const [session, setSession] = useState<QuizSession>(EMPTY_SESSION)
  const [task, setTask] = useState<QuizTask | null>(null)
  const recentRef = useRef<string[]>([])
  const [resetOpen, setResetOpen] = useState(false)

  // ---------------------------------------------------------------- cross-tab request
  useEffect(() => {
    if (!quizRequest) return
    setSelected([quizRequest.openingId])
    setMode(quizRequest.mode ?? 'line')
    setLineChoice(quizRequest.lineId ? lineKey(quizRequest.openingId, quizRequest.lineId) : RANDOM_LINE)
    setTask(null)
    clearRequest('quiz')
  }, [quizRequest, clearRequest])

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const ac = new AbortController()
    api
      .listOpenings(ac.signal)
      .then((list) => {
        setOpenings(list)
        setOpeningsError(null)
      })
      .catch((err: unknown) => {
        if (!isAbort(err)) setOpeningsError(errorText(err))
      })
    return () => ac.abort()
  }, [reloadToken])

  /** Selection limited to known openings; empty (or all unknown) means every opening. */
  const effectiveSelected = useMemo(() => {
    if (!openings) return []
    const known = selected.filter((id) => openings.some((o) => o.id === id))
    return known.length ? openings.filter((o) => known.includes(o.id)).map((o) => o.id) : openings.map((o) => o.id)
  }, [openings, selected])
  const selKey = effectiveSelected.join(',')
  const apiMode = mode === 'traps' ? 'traps' : 'positions'

  // full openings (tree + lines) for every selected opening
  useEffect(() => {
    const ids = selKey ? selKey.split(',') : []
    const missing = ids.filter((id) => !fullsRef.current[id])
    if (missing.length === 0) return
    const ac = new AbortController()
    void Promise.allSettled(missing.map((id) => api.getOpening(id, ac.signal))).then((results) => {
      if (ac.signal.aborted) return
      const add: Record<string, OpeningFull> = {}
      let err: string | null = null
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') add[missing[i]] = r.value
        else if (!isAbort(r.reason)) err = `Could not load ${missing[i]}: ${errorText(r.reason)}`
      })
      fullsRef.current = { ...fullsRef.current, ...add }
      setFulls(fullsRef.current)
      setDataError(err)
    })
    return () => ac.abort()
  }, [selKey, reloadToken])

  // quiz items (positions / traps) for every selected opening
  useEffect(() => {
    if (mode === 'line') return
    const ids = selKey ? selKey.split(',') : []
    const missing = ids.filter((id) => !itemsRef.current[`${apiMode}:${id}`])
    if (missing.length === 0) return
    const ac = new AbortController()
    void Promise.allSettled(missing.map((id) => api.getQuiz(id, apiMode, ITEM_LIMIT, ac.signal))).then((results) => {
      if (ac.signal.aborted) return
      const add: Record<string, QuizItem[]> = {}
      let err: string | null = null
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') add[`${apiMode}:${missing[i]}`] = r.value
        else if (!isAbort(r.reason)) err = `Could not load the ${apiMode} quiz of ${missing[i]}: ${errorText(r.reason)}`
      })
      itemsRef.current = { ...itemsRef.current, ...add }
      setItemsCache(itemsRef.current)
      setDataError(err)
    })
    return () => ac.abort()
  }, [selKey, mode, apiMode, reloadToken])

  const fullsReady = effectiveSelected.length > 0 && effectiveSelected.every((id) => fulls[id])
  const itemsReady = mode === 'line' || (effectiveSelected.length > 0 && effectiveSelected.every((id) => itemsCache[`${apiMode}:${id}`]))
  const ready = fullsReady && itemsReady

  const lineCandidates = useMemo<LineCandidate[]>(
    () => effectiveSelected.flatMap((id) => (fulls[id] ? fulls[id].lines.map((line) => ({ opening: fulls[id], line })) : [])),
    [effectiveSelected, fulls],
  )
  const itemPool = useMemo<QuizItem[]>(
    () => (mode === 'line' ? [] : effectiveSelected.flatMap((id) => itemsCache[`${apiMode}:${id}`] ?? [])),
    [mode, apiMode, effectiveSelected, itemsCache],
  )
  const itemCounts = useMemo(() => {
    if (mode === 'line') return undefined
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(itemsCache)) {
      const [m, id] = k.split(':')
      if (m === apiMode) out[id] = v.length
    }
    return out
  }, [mode, apiMode, itemsCache])
  const lineGroups = useMemo(() => buildLineGroups(effectiveSelected, fulls), [effectiveSelected, fulls])
  const lineOrder = useMemo(() => lineGroups.flatMap((g) => g.options.map((o) => o.key)), [lineGroups])

  // ---------------------------------------------------------------- choosing tasks
  const sideOf = useCallback((openingId: string) => openings?.find((o) => o.id === openingId)?.side ?? 'white', [openings])

  /** A new task for the current mode/selection, or null when there is nothing to ask. */
  const buildNext = useCallback(
    (current: QuizTask | null): QuizTask | null => {
      if (mode === 'line') {
        const chosen = lineChoice !== RANDOM_LINE ? parseLineKey(lineChoice) : null
        if (chosen) {
          const f = fulls[chosen.openingId]
          const line = f?.lines.find((l) => l.id === chosen.lineId)
          if (f && line) return buildLineTask(f, line)
        }
        const exclude = current?.line ? lineKey(current.openingId, current.line.id) : undefined
        const pick = pickRandomLine(lineCandidates, stats, exclude)
        return pick ? buildLineTask(pick.opening, pick.line) : null
      }
      const item = pickItem(itemPool, stats, recentRef.current)
      if (!item) return null
      recentRef.current = [...recentRef.current.slice(-19), itemKey(item)]
      const asked = apiMode === 'positions' ? withTranspositions(item, itemPool) : item
      return buildItemTask(apiMode, asked, fulls[item.openingId], sideOf(item.openingId))
    },
    [mode, lineChoice, fulls, lineCandidates, stats, itemPool, apiMode, sideOf],
  )

  const stale =
    !task ||
    task.mode !== mode ||
    !effectiveSelected.includes(task.openingId) ||
    (mode === 'line' && lineChoice !== RANDOM_LINE && (!task.line || lineKey(task.openingId, task.line.id) !== lineChoice))

  useEffect(() => {
    if (!stale || !ready) return
    if (mode === 'line' && lineChoice !== RANDOM_LINE && !lineOrder.includes(lineChoice)) {
      // the requested line does not exist (or its opening is not selected): fall back to random
      setLineChoice(RANDOM_LINE)
      return
    }
    setTask(buildNext(null))
  }, [stale, ready, mode, lineChoice, lineOrder, buildNext])

  // ---------------------------------------------------------------- handlers
  const handleResult = useCallback((t: QuizTask, nodeId: string, correct: boolean) => {
    setStats(recordQuizResult(t.openingId, nodeId, correct))
    setSession((s) => {
      const streak = correct ? s.streak + 1 : 0
      return { correct: s.correct + (correct ? 1 : 0), total: s.total + 1, streak, best: Math.max(s.best, streak) }
    })
  }, [])

  const handleNext = useCallback(() => {
    if (mode === 'line' && lineChoice !== RANDOM_LINE && lineOrder.length > 0) {
      const i = lineOrder.indexOf(lineChoice)
      const nextKey = lineOrder[(i + 1) % lineOrder.length]
      if (nextKey === lineChoice && task) setTask(restartTask(task))
      else setLineChoice(nextKey)
      return
    }
    const next = buildNext(task)
    if (next) setTask(next)
    else if (task) setTask(restartTask(task))
  }, [mode, lineChoice, lineOrder, task, buildNext])

  const handleRestart = useCallback(() => {
    setTask((cur) => (cur ? restartTask(cur) : cur))
  }, [])

  const handleOpenLearn = useCallback(
    (t: QuizTask, sans: string[]) => navigate('learn', { openingId: t.openingId, nodeId: nodeIdFromSans(sans) }),
    [navigate],
  )

  const toggleOpening = (id: string) => {
    if (!openings) return
    const cur = effectiveSelected
    let next: string[]
    if (cur.length === openings.length && cur.includes(id)) next = [id] // from "All": focus on this one
    else if (cur.includes(id)) next = cur.filter((x) => x !== id)
    else next = [...cur, id]
    if (next.length === 0) return
    setSelected(next)
    const chosen = parseLineKey(lineChoice)
    if (chosen && !next.includes(chosen.openingId)) setLineChoice(RANDOM_LINE)
  }

  const selectAll = () => {
    if (openings) setSelected(openings.map((o) => o.id))
  }

  const changeMode = (m: QuizMode) => {
    if (m !== mode) setMode(m)
  }

  const doReset = (scope: 'all' | 'selected') => {
    setStats(resetQuizStats(scope === 'all' ? undefined : effectiveSelected))
    setSession(EMPTY_SESSION)
    recentRef.current = []
    setResetOpen(false)
  }

  // ---------------------------------------------------------------- render
  if (openingsError && !openings) {
    return (
      <div className="tab-placeholder">
        <EmptyState
          icon="warning"
          title="Could not load the openings"
          description={openingsError}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setReloadToken((n) => n + 1)}>
              Retry
            </button>
          }
        />
      </div>
    )
  }

  if (openings && openings.length === 0) {
    return (
      <div className="tab-placeholder">
        <EmptyState icon="book" title="No openings yet" description="Add opening files to data/openings/ and they will show up here." />
      </div>
    )
  }

  const settingsPanel = openings ? (
    <QuizSettingsPanel
      mode={mode}
      onModeChange={changeMode}
      openings={openings}
      selected={effectiveSelected}
      onToggleOpening={toggleOpening}
      onSelectAll={selectAll}
      lineChoice={lineChoice}
      onLineChoice={setLineChoice}
      lineGroups={lineGroups}
      itemCounts={itemCounts}
    />
  ) : null

  const statsPanel = openings ? (
    <QuizStatsPanel session={session} stats={stats} openings={openings} selected={effectiveSelected} onReset={() => setResetOpen(true)} />
  ) : null

  const showTask = task && !stale ? task : null

  return (
    <div className="workspace quiz-tab" data-testid="quiz-tab">
      {showTask ? (
        <QuizExercise
          key={showTask.key}
          task={showTask}
          coordinates={settings.coordinates}
          onResult={handleResult}
          onNext={handleNext}
          onRestart={handleRestart}
          onOpenLearn={handleOpenLearn}
          sideTop={settingsPanel}
          sideBottom={statsPanel}
        />
      ) : (
        <>
          <div className="workspace-board" style={{ '--below-board-h': '112px' } as CSSProperties}>
            <div className="board-frame">
              <Board fen={START_FEN} interactive={false} coordinates={settings.coordinates} />
            </div>
          </div>
          <div className="workspace-side">
            {settingsPanel}
            <div className="panel grow quiz-exercise">
              <div className="panel-body quiz-waiting">
                {dataError ? (
                  <EmptyState
                    icon="warning"
                    title="Could not load the quiz"
                    description={dataError}
                    action={
                      <button type="button" className="btn btn-primary" onClick={() => setReloadToken((n) => n + 1)}>
                        Retry
                      </button>
                    }
                  />
                ) : !ready || !openings ? (
                  <div className="row muted">
                    <Spinner /> Loading the quiz...
                  </div>
                ) : (
                  <EmptyState
                    icon="target"
                    title={mode === 'traps' ? 'No trap positions here' : 'Nothing to quiz'}
                    description={
                      mode === 'traps'
                        ? 'The selected openings have no trap lines. Pick other openings or another mode.'
                        : 'The selected openings have no positions for this mode.'
                    }
                  />
                )}
              </div>
            </div>
            {statsPanel}
          </div>
        </>
      )}

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset quiz statistics?"
        width={440}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </button>
            {openings && effectiveSelected.length < openings.length ? (
              <button type="button" className="btn" onClick={() => doReset('selected')} data-testid="quiz-reset-selected">
                Selected openings only
              </button>
            ) : null}
            <button type="button" className="btn btn-danger" onClick={() => doReset('all')} data-testid="quiz-reset-all">
              Reset all
            </button>
          </>
        }
      >
        <p>
          This forgets which positions you know, so mastery starts again from 0% and weak positions are no longer asked first.
          The session score and streak are reset too.
        </p>
      </Modal>
    </div>
  )
}
