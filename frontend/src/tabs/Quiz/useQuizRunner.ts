/**
 * State machine of one quiz exercise (see QuizTasks.ts for the rules).
 *
 * The hook is meant to live in a component keyed by `task.key`, so a new task always starts from
 * a fresh state. Student moves come from the Board (`onMove`); opponent replies are played from
 * the data after OPPONENT_DELAY_MS. `onResult` fires exactly once per student turn: `true` when
 * the first try was right, `false` at the first wrong try (or when the student gives up).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LineMeta } from '../../api/types'
import { tryMove, moveToUci, type PromotionPiece, type Square } from '../../lib/chess'
import { nodeIdFromSans } from '../../lib/tree'
import { playSound } from '../../lib/sounds'
import {
  consistentLines,
  expectedMoves,
  maxTries,
  opponentMove,
  otherBookMove,
  playSan,
  positionAfter,
  sameSan,
  turnAt,
  whyOf,
  type ExpectedMove,
  type QuizTask,
  type Turn,
} from './QuizTasks'

export const OPPONENT_DELAY_MS = 400

export type MoveMark = 'clean' | 'retry' | 'mistake'

export interface PlayedMove {
  /** Index in the full SAN path (0 = 1.White). */
  index: number
  san: string
  why: string
  by: 'student' | 'opponent'
  mark?: MoveMark
}

export type Feedback =
  | { tone: 'good'; san: string; why: string; lineNames: string[]; others: ExpectedMove[]; afterRetry: boolean }
  | { tone: 'bad'; san: string; triesLeft: number }
  | { tone: 'info'; san: string; lineNames: string[] }
  | { tone: 'reveal'; moves: ExpectedMove[]; wrongSan: string | null }
  | { tone: 'follow'; san: string }

export interface RunnerState {
  sans: string[]
  fen: string
  lastUci: string | null
  /** Traps: continuation lines still consistent with the moves played. */
  chosen: LineMeta[]
  /** Wrong tries at the current student turn. */
  tries: number
  /** Moves revealed at the current turn (the student then has to play one of them). */
  revealed: ExpectedMove[] | null
  /** The last wrong move, drawn as a red arrow while the answer is revealed. */
  wrongUci: string | null
  /** Position quiz: ended by a wrong answer. */
  forcedDone: boolean
  /** Moves played since the exercise started. */
  played: PlayedMove[]
  /** Student turns so far, split by outcome. */
  clean: number
  retries: number
  mistakes: number
  feedback: Feedback | null
}

function initialState(task: QuizTask): RunnerState {
  let fen: string
  let lastUci: string | null
  if (task.item) {
    fen = task.item.fen
    lastUci = positionAfter(task.startSans).lastUci
  } else {
    const p = positionAfter(task.startSans)
    fen = p.fen
    lastUci = p.lastUci
  }
  return {
    sans: [...task.startSans],
    fen,
    lastUci,
    chosen: task.trapLines ?? [],
    tries: 0,
    revealed: null,
    wrongUci: null,
    forcedDone: false,
    played: [],
    clean: 0,
    retries: 0,
    mistakes: 0,
    feedback: null,
  }
}

export interface QuizRunner {
  state: RunnerState
  turn: Turn
  /** Moves accepted at the current student turn (empty when it is not the student's turn). */
  expected: ExpectedMove[]
  onMove: (from: Square, to: Square, promotion?: PromotionPiece) => void
  /** Reveal the answer now (counts as a miss). */
  giveUp: () => void
  /** Play the revealed move for the student. */
  playRevealed: () => void
  /** Bumped on every wrong move (pass to `Board shake`). */
  shake: number
}

export function useQuizRunner(task: QuizTask, onResult: (task: QuizTask, nodeId: string, correct: boolean) => void): QuizRunner {
  const [state, setState] = useState<RunnerState>(() => initialState(task))
  const [shake, setShake] = useState(0)

  const turn: Turn = state.forcedDone ? 'done' : turnAt(task, state.sans, state.fen, state.chosen)
  const expected = useMemo(
    () => (turn === 'student' ? expectedMoves(task, state.sans, state.fen, state.chosen) : []),
    [turn, task, state.sans, state.fen, state.chosen],
  )

  // opponent replies from the data
  useEffect(() => {
    if (turn !== 'opponent') return
    const timer = setTimeout(() => {
      setState((s) => {
        const san = opponentMove(task, s.sans, s.chosen)
        if (!san) return s
        const res = playSan(s.fen, san)
        if (!res) return s
        const sans = [...s.sans, res.san]
        return {
          ...s,
          sans,
          fen: res.fen,
          lastUci: res.uci,
          chosen: task.mode === 'traps' ? consistentLines(s.chosen, sans) : s.chosen,
          played: [...s.played, { index: s.sans.length, san: res.san, why: whyOf(task, sans), by: 'opponent' }],
        }
      })
    }, OPPONENT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [turn, state.sans.length, task])

  /** Accept a student move (already validated against `allowed`). */
  const accept = useCallback(
    (s: RunnerState, move: ExpectedMove, fenAfter: string, uci: string, san: string, allowed: ExpectedMove[]): RunnerState => {
      const nodeId = nodeIdFromSans(s.sans)
      let mark: MoveMark
      if (s.revealed) mark = 'mistake'
      else if (s.tries > 0) mark = 'retry'
      else {
        mark = 'clean'
        onResult(task, nodeId, true)
      }
      const sans = [...s.sans, san]
      return {
        ...s,
        sans,
        fen: fenAfter,
        lastUci: uci,
        chosen: task.mode === 'traps' ? consistentLines(s.chosen, sans) : s.chosen,
        tries: 0,
        revealed: null,
        wrongUci: null,
        clean: s.clean + (mark === 'clean' ? 1 : 0),
        retries: s.retries + (mark === 'retry' ? 1 : 0),
        played: [...s.played, { index: s.sans.length, san, why: move.why || whyOf(task, sans), by: 'student', mark }],
        feedback:
          mark === 'mistake'
            ? { tone: 'follow', san }
            : {
                tone: 'good',
                san,
                why: move.why || whyOf(task, sans),
                lineNames: move.lineNames,
                others: allowed.filter((m) => !sameSan(m.san, san)),
                afterRetry: mark === 'retry',
              },
      }
    },
    [onResult, task],
  )

  /** Reveal the answer at the current turn; `wrongSan` is the move that triggered it (if any). */
  const reveal = useCallback(
    (s: RunnerState, allowed: ExpectedMove[], wrongSan: string | null, wrongUci: string | null): RunnerState => ({
      ...s,
      revealed: allowed,
      wrongUci,
      mistakes: s.mistakes + 1,
      forcedDone: task.mode === 'positions',
      feedback: { tone: 'reveal', moves: allowed, wrongSan },
    }),
    [task.mode],
  )

  const onMove = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece) => {
      if (turn !== 'student') return
      const mv = tryMove(state.fen, from, to, promotion)
      if (!mv) return
      const uci = moveToUci(mv)
      const allowed = state.revealed ?? expected
      const match = allowed.find((m) => m.uci === uci || sameSan(m.san, mv.san))
      if (match) {
        setState(accept(state, match, mv.after, uci, mv.san, allowed))
        return
      }
      // wrong move
      playSound('illegal')
      if (state.revealed) {
        setState({ ...state, wrongUci: uci, feedback: { tone: 'reveal', moves: state.revealed, wrongSan: mv.san } })
        setShake((n) => n + 1)
        return
      }
      const book = otherBookMove(task, state.sans, mv.san)
      if (book) {
        // a move from another line of the repertoire: not wrong, just not this line
        setState({ ...state, feedback: { tone: 'info', san: book.san, lineNames: book.lineNames } })
        return
      }
      setShake((n) => n + 1)
      const tries = state.tries + 1
      if (tries === 1) onResult(task, nodeIdFromSans(state.sans), false)
      const limit = maxTries(task, state.sans)
      if (tries >= limit) {
        setState(reveal({ ...state, tries }, allowed, mv.san, uci))
      } else {
        setState({ ...state, tries, feedback: { tone: 'bad', san: mv.san, triesLeft: limit - tries } })
      }
    },
    [turn, state, expected, accept, reveal, onResult, task],
  )

  const giveUp = useCallback(() => {
    if (turn !== 'student' || state.revealed || expected.length === 0) return
    if (state.tries === 0) onResult(task, nodeIdFromSans(state.sans), false)
    setState(reveal({ ...state, tries: state.tries + 1 }, expected, null, null))
  }, [turn, state, expected, reveal, onResult, task])

  const playRevealed = useCallback(() => {
    if (turn !== 'student' || !state.revealed || state.revealed.length === 0) return
    const move = state.revealed[0]
    const res = playSan(state.fen, move.san)
    if (!res) return
    setState(accept(state, move, res.fen, res.uci, res.san, state.revealed))
  }, [turn, state, accept])

  return { state, turn, expected, onMove, giveUp, playRevealed, shake }
}
