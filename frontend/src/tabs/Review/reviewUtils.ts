/**
 * Pure helpers for the Review tab: phrasing, graph scaling, positions per ply, persistence shape.
 */
import type { Classification, Players, ReviewMove, ReviewResult, Score, Side } from '../../api/types'
import { START_FEN, plyOffsetFromFen } from '../../lib/chess'
import { mateWinner } from '../../lib/eval'

/** Order of the classification count table (chess.com game report order). */
export const REVIEW_TABLE_ORDER: readonly Classification[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
]

/** Moves worth an explanation in "Explain all key moments" (and marked on the eval graph). */
export const REVIEW_KEY_MOMENTS: readonly Classification[] = ['blunder', 'mistake', 'miss', 'inaccuracy', 'brilliant', 'great']

export function isKeyMoment(c: Classification): boolean {
  return REVIEW_KEY_MOMENTS.includes(c)
}

/** 1-based plies of the key moments, in game order. */
export function keyMomentPlies(result: ReviewResult): number[] {
  return result.moves.filter((m) => isKeyMoment(m.classification)).map((m) => m.ply)
}

/** "Nf3 is a mistake" style sentence. */
export function classificationSentence(san: string, c: Classification): string {
  switch (c) {
    case 'brilliant':
      return `${san} is brilliant`
    case 'great':
      return `${san} is a great move`
    case 'best':
      return `${san} is the best move`
    case 'excellent':
      return `${san} is excellent`
    case 'good':
      return `${san} is good`
    case 'book':
      return `${san} is a book move`
    case 'inaccuracy':
      return `${san} is an inaccuracy`
    case 'mistake':
      return `${san} is a mistake`
    case 'blunder':
      return `${san} is a blunder`
    case 'miss':
      return `${san} is a miss`
  }
}

/** Eval graph scale: centipawn scores are clipped to +-8 pawns, mate is drawn at +-10. */
export const GRAPH_CLIP = 8
export const GRAPH_MATE = 10

/** Graph value in pawns from White's point of view. `{ mate: 0 }` resolves via `fen` (side to move is mated). */
export function graphValue(score: Score, fen?: string): number {
  const winner = mateWinner(score, fen)
  if (winner !== null) return winner * GRAPH_MATE
  const pawns = (score as { cp: number }).cp / 100
  return Math.max(-GRAPH_CLIP, Math.min(GRAPH_CLIP, pawns))
}

/** Position before the first move. */
export function reviewStartFen(result: ReviewResult): string {
  return result.moves[0]?.fenBefore ?? START_FEN
}

/** Absolute ply count before moves[0] (0 for a game from the initial position). */
export function reviewPlyOffset(result: ReviewResult): number {
  return plyOffsetFromFen(reviewStartFen(result))
}

export interface ReviewPosition {
  fen: string
  /** White-POV eval of `fen`. */
  score: Score | null
  /** The move that led here (null at ply 0). */
  move: ReviewMove | null
}

/** Position shown for `ply` (0 = start, i = after moves[i-1]). */
export function positionAt(result: ReviewResult, ply: number): ReviewPosition {
  if (ply <= 0 || result.moves.length === 0) {
    const first = result.moves[0]
    return { fen: reviewStartFen(result), score: first ? first.evalBefore : null, move: null }
  }
  const m = result.moves[Math.min(ply, result.moves.length) - 1]
  return { fen: m.fenAfter, score: m.evalAfter, move: m }
}

/** Graph values for plies 0..N. */
export function graphValues(result: ReviewResult): number[] {
  const out: number[] = []
  const first = result.moves[0]
  out.push(first ? graphValue(first.evalBefore, first.fenBefore) : 0)
  for (const m of result.moves) out.push(graphValue(m.evalAfter, m.fenAfter))
  return out
}

export function sideName(players: Players | undefined, side: Side): string {
  const n = players?.[side]?.trim()
  return n ? n : side === 'white' ? 'White' : 'Black'
}

/** Accuracy for display: one decimal like chess.com. */
export function formatAccuracy(a: number | undefined): string {
  if (a === undefined || !Number.isFinite(a)) return '–'
  return a.toFixed(1)
}

/** "5 min ago", "2 h ago", "3 days ago". */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** Players from PGN headers ("?" or empty names fall back to undefined). */
export function playersFromHeaders(headers: Record<string, string>): Players | undefined {
  const clean = (v: string | undefined) => (v && v.trim() && v.trim() !== '?' ? v.trim() : '')
  const white = clean(headers.White)
  const black = clean(headers.Black)
  if (!white && !black) return undefined
  return { white: white || 'White', black: black || 'Black' }
}

/** The game a review was started for (kept with the result for display and persistence). */
export interface ReviewGame {
  sans: string[]
  startFen?: string
  players?: Players
  /** "1-0" | "0-1" | "1/2-1/2" | "*" when known. */
  result?: string
  /** Where it came from, for the header ("Last game", "PGN"). */
  source: 'last' | 'pgn' | 'request'
}

/** localStorage key of the last review (survives tab switches and reloads). */
export const REVIEW_STATE_KEY = 'review-state-v1'

export interface SavedReviewState {
  jobId: string
  game: ReviewGame
  result?: ReviewResult
  /** Finished explanations by ply. */
  explanations?: Record<number, string>
  savedAt: number
}

/** Map backend/socket error text to something friendlier. */
export function friendlyExplainError(message: string): { kind: 'ollama' | 'gone' | 'model' | 'other'; text: string } {
  const m = message.toLowerCase()
  if (m.includes('unknown review job')) {
    return {
      kind: 'gone',
      text: 'This review is no longer on the server (the backend was restarted). Run the review again to get explanations.',
    }
  }
  if (m.includes('not installed') || m.includes('not found') || m.includes('unknown model')) {
    return { kind: 'model', text: `The selected model is not available: ${message}` }
  }
  if (
    m.includes('ollama') ||
    m.includes('connect') ||
    m.includes('refused') ||
    m.includes('unreachable') ||
    m.includes('11434') ||
    m.includes('socket')
  ) {
    return { kind: 'ollama', text: message }
  }
  return { kind: 'other', text: message }
}
