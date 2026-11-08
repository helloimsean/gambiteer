/**
 * Moves tried on the review board: one side line branching off the game, with each move graded by
 * Stockfish (POST /api/coach/move). The game's own report is never changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestCoach } from '../../api/client'
import type { CoachMove, Score } from '../../api/types'
import { parseUci, tryMove } from '../../lib/chess'

/** The range POST /api/coach/move accepts. */
const MIN_DEPTH = 8
const MAX_DEPTH = 22

export interface VariationMove {
  id: number
  san: string
  uci: string
  fenBefore: string
  fenAfter: string
  /** The review already named this the best move here, so it must not be graded as anything else. */
  knownBest: boolean
  verdict: CoachMove | null
  error: string | null
}

export interface ReviewVariation {
  /** Ply of the game the line branches from (it replaces the game's move basePly + 1). */
  basePly: number
  moves: VariationMove[]
  /** Shown move, 1..moves.length. */
  index: number
}

export interface TriedMove {
  fenBefore: string
  basePly: number
  /** How many moves of the current line stay in front of this one. */
  keep: number
  uci: string
  knownBest?: boolean
}

export interface ReviewVariationApi {
  variation: ReviewVariation | null
  play: (move: TriedMove) => void
  select: (index: number) => void
  clear: () => void
  retry: (move: VariationMove) => void
}

/**
 * The review and this later check are separate searches and can name different top moves, so a
 * move the review called best stays "best" here rather than being contradicted a moment later.
 */
function gradedVerdict(move: VariationMove, verdict: CoachMove): CoachMove {
  if (!move.knownBest) return verdict
  return { ...verdict, classification: 'best', bestMove: { san: move.san, uci: move.uci, pv: [] } }
}

/** Eval to show on a tried move: its own, or the nearest earlier one while it is being checked. */
export function variationEval(variation: ReviewVariation, fallback: Score | null): Score | null {
  for (let i = variation.index - 1; i >= 0; i--) {
    const verdict = variation.moves[i].verdict
    if (verdict) return verdict.evalAfter
  }
  return fallback
}

export function useReviewVariation(reviewDepth: number): ReviewVariationApi {
  const [variation, setVariation] = useState<ReviewVariation | null>(null)
  const nextIdRef = useRef(1)
  const abortRef = useRef<AbortController | null>(null)
  const depth = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, reviewDepth))

  useEffect(() => () => abortRef.current?.abort(), [])

  const check = useCallback(
    (move: VariationMove) => {
      // a change to moves that were dropped from the line finds nothing to update
      const update = (change: Partial<VariationMove>) =>
        setVariation((v) => v && { ...v, moves: v.moves.map((m) => (m.id === move.id ? { ...m, ...change } : m)) })
      abortRef.current ??= new AbortController()
      const { signal } = abortRef.current
      update({ error: null })
      requestCoach({ requestId: String(move.id), fen: move.fenBefore, uci: move.uci, explain: false, depth }, signal)
        .then((res) => update({ verdict: gradedVerdict(move, res.move) }))
        .catch((err: unknown) => {
          if (!signal.aborted) update({ error: err instanceof Error ? err.message : String(err) })
        })
    },
    [depth],
  )

  const play = useCallback(
    ({ fenBefore, basePly, keep, uci, knownBest = false }: TriedMove) => {
      if (variation && variation.moves[keep]?.uci === uci) {
        setVariation({ ...variation, index: keep + 1 })
        return
      }
      const { from, to, promotion } = parseUci(uci)
      const played = tryMove(fenBefore, from, to, promotion)
      if (!played) return
      const move: VariationMove = {
        id: nextIdRef.current++,
        san: played.san,
        uci,
        fenBefore,
        fenAfter: played.after,
        knownBest,
        verdict: null,
        error: null,
      }
      const moves = [...(variation?.moves.slice(0, keep) ?? []), move]
      setVariation({ basePly, moves, index: moves.length })
      check(move)
    },
    [variation, check],
  )

  const select = useCallback((index: number) => setVariation((v) => v && { ...v, index }), [])

  const clear = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setVariation(null)
  }, [])

  return { variation, play, select, clear, retry: check }
}
