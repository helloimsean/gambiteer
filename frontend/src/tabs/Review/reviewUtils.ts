/**
 * Pure helpers for the Review tab: phrasing, graph scaling, positions per ply, persistence shape.
 */
import type { Classification, Players, ReviewMove, ReviewRequest, ReviewResult, Score, Side } from '../../api/types'
import { START_FEN, plyOffsetFromFen, sansToPgn } from '../../lib/chess'
import { mateWinner } from '../../lib/eval'
import { t } from '../../lib/i18n'
import { pgnFileName } from '../../lib/pgnTransfer'
import type { SoundName } from '../../lib/sounds'
import type { ReviewEngineChoice } from '../../state/AppContext'

/** Levy Rozman's line for a brilliant or great queen or rook sacrifice, if `move` is one. */
export function sacrificeSound(move: ReviewMove | undefined): SoundName | null {
  if (!move || (move.classification !== 'brilliant' && move.classification !== 'great')) return null
  if (move.sacrifice === 'queen') return 'sacrificeQueen'
  if (move.sacrifice === 'rook') return 'sacrificeRook'
  return null
}

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
      return t('{san} is brilliant', { san })
    case 'great':
      return t('{san} is a great move', { san })
    case 'best':
      return t('{san} is the best move', { san })
    case 'excellent':
      return t('{san} is excellent', { san })
    case 'good':
      return t('{san} is good', { san })
    case 'book':
      return t('{san} is a book move', { san })
    case 'inaccuracy':
      return t('{san} is an inaccuracy', { san })
    case 'mistake':
      return t('{san} is a mistake', { san })
    case 'blunder':
      return t('{san} is a blunder', { san })
    case 'miss':
      return t('{san} is a miss', { san })
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
  if (n === 'You') return t('You') // saved by the Play tab in English
  return n ? n : side === 'white' ? t('White') : t('Black')
}

/** Accuracy for display: one decimal like chess.com. */
export function formatAccuracy(a: number | undefined): string {
  if (a === undefined || !Number.isFinite(a)) return '–'
  return a.toFixed(1)
}

/** "5 min ago", "2 h ago", "3 days ago". */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return t('just now')
  const m = Math.round(s / 60)
  if (m < 60) return t('{m} min ago', { m })
  const h = Math.round(m / 60)
  if (h < 48) return t('{h} h ago', { h })
  const days = Math.round(h / 24)
  return t('{days} days ago', { days })
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
  /** PGN Date tag ("2026.11.06") when known. */
  date?: string
  /** Where it came from, for the header ("Last game", "PGN"). */
  source: 'last' | 'pgn'
}

/** The reviewed game as a PGN: its moves and players, without the review's classifications. */
export function reviewPgn(game: ReviewGame): string {
  const result = game.result ?? '*'
  const headers = {
    Event: 'Game Review',
    Site: 'Gambiteer',
    Date: game.date ?? '????.??.??',
    White: game.players?.white ?? '?',
    Black: game.players?.black ?? '?',
    Result: result,
  }
  return sansToPgn(game.sans, { headers, result, startFen: game.startFen })
}

export function reviewFileName(game: ReviewGame): string {
  const date = game.date?.includes('?') ? undefined : game.date
  return pgnFileName([game.players?.white ?? 'White', 'vs', game.players?.black ?? 'Black', date].filter(Boolean).join(' '))
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
      text: t('This review is no longer on the server (the backend was restarted). Run the review again to get explanations.'),
    }
  }
  if (m.includes('not installed') || m.includes('not found') || m.includes('unknown model')) {
    return { kind: 'model', text: t('The selected model is not available: {message}', { message }) }
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

/** The request fields for a choice; settings left at the backend's own are left out. */
export function engineRequestFields(choice: ReviewEngineChoice): Pick<ReviewRequest, 'threads' | 'hashMb' | 'moveTimeMs'> {
  const out: Pick<ReviewRequest, 'threads' | 'hashMb' | 'moveTimeMs'> = {}
  if (choice.threads) out.threads = choice.threads
  if (choice.hashMb) out.hashMb = choice.hashMb
  if (choice.moveTimeMs) out.moveTimeMs = choice.moveTimeMs
  return out
}
