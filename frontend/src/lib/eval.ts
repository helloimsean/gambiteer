/**
 * Evaluation maths. API scores are always White-POV; these helpers convert for display.
 *
 * Mate scores: `{ mate: n }` with n > 0 = White mates in n, n < 0 = Black mates in |n|.
 * `{ mate: 0 }` means the position on the board IS checkmate: the side to move in its FEN is
 * mated (backend contract). Without the FEN the winner is unknown, so every helper that needs a
 * winner accepts an optional `fen` and treats an unresolved `{ mate: 0 }` as neutral.
 */
import type { Score, Side } from '../api/types'

export const MATE_CP = 1500

/** Score seen from `pov` (flips sign for Black). */
export function scoreForPov(score: Score, pov: Side): Score {
  if (pov === 'white') return score
  return 'mate' in score ? { mate: -score.mate } : { cp: -score.cp }
}

/**
 * Who is mating, from White's point of view: +1 White mates, -1 Black mates, 0 unknown
 * (`{ mate: 0 }` without a FEN). `null` for a centipawn score.
 */
export function mateWinner(score: Score, fen?: string): 1 | -1 | 0 | null {
  if (!('mate' in score)) return null
  if (score.mate > 0) return 1
  if (score.mate < 0) return -1
  if (!fen) return 0
  // { mate: 0 }: the side to move is checkmated
  return (fen.split(' ')[1] ?? 'w') === 'w' ? -1 : 1
}

/** Centipawn number for graphs (from `pov`): mate is mapped to +-MATE_CP, cp clamped to +-MATE_CP. */
export function scoreToCp(score: Score, pov: Side = 'white', fen?: string): number {
  const sign = pov === 'white' ? 1 : -1
  const winner = mateWinner(score, fen)
  if (winner !== null) return winner * sign * MATE_CP
  const cp = (score as { cp: number }).cp * sign
  return Math.max(-MATE_CP, Math.min(MATE_CP, cp))
}

/**
 * Win percentage 0..100 from `pov` using the lichess/chess.com sigmoid:
 * `50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`, cp clamped to +-1500; mate = 100/0.
 */
export function winPct(score: Score, pov: Side = 'white', fen?: string): number {
  const winner = mateWinner(score, fen)
  if (winner !== null) {
    if (winner === 0) return 50
    const forPov = pov === 'white' ? winner : -winner
    return forPov > 0 ? 100 : 0
  }
  const cp = scoreToCp(score, pov)
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

/**
 * "+1.3", "-0.4", "0.0", "M3", "-M2", "#" (already mate). `pov` defaults to White so the label
 * matches the usual convention (positive = White ahead).
 */
export function formatScore(score: Score | null | undefined, pov: Side = 'white'): string {
  if (!score) return '…'
  const s = scoreForPov(score, pov)
  if ('mate' in s) {
    if (s.mate === 0) return '#'
    return s.mate > 0 ? `M${s.mate}` : `-M${Math.abs(s.mate)}`
  }
  const pawns = s.cp / 100
  if (Math.abs(pawns) < 0.05) return '0.0'
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`
}

/**
 * Share of the eval bar (0..1) that should be white. Mate fills the bar for the mating side;
 * pass `fen` so that `{ mate: 0 }` (checkmate on the board) resolves to the winner.
 * Centipawn scores are kept within 3%..97% so both colours stay visible.
 */
export function evalBarWhiteShare(score: Score | null | undefined, fen?: string): number {
  if (!score) return 0.5
  const winner = mateWinner(score, fen)
  if (winner !== null) return winner === 0 ? 0.5 : winner > 0 ? 1 : 0
  const share = winPct(score, 'white') / 100
  return Math.min(0.97, Math.max(0.03, share))
}

/** Per-move accuracy (lichess formula) from the win% drop. */
export function moveAccuracy(drop: number): number {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669
  return Math.max(0, Math.min(100, a))
}

/** True when the score says the side `pov` is winning by at least `cp` centipawns. */
export function isWinningFor(score: Score, pov: Side, cp = 150, fen?: string): boolean {
  return scoreToCp(score, pov, fen) >= cp
}
