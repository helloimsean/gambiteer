/**
 * Finished Play games, newest first, in localStorage (`game-history-v1`). Accuracy is added when
 * a game is reviewed, because only a review calculates it.
 */
import type { BotKind, Players, Side, VariantId } from '../api/types'
import type { LastGame } from '../state/AppContext'
import { START_FEN } from './chess'
import { loadJson, saveJson } from './storage'

export const GAME_HISTORY_KEY = 'game-history-v1'

/** At under 1 kB per game this stays well inside the 5 MB a browser gives the whole app. */
const MAX_GAMES = 1000

export interface GameAccuracy {
  white: number
  black: number
}

export interface HistoryGame extends LastGame {
  id: string
  bot: BotKind
  elo: number
  studentColor: Side
  players: Players
  result: string
  /** Missing until the game has been reviewed. */
  accuracy?: GameAccuracy
  /** Missing for standard chess. Review and Analyze cannot open the other variants. */
  variant?: VariantId
}

type GameMoves = Pick<LastGame, 'sans' | 'startFen'>

export function sameMoves(a: GameMoves, b: GameMoves): boolean {
  return (a.startFen ?? START_FEN) === (b.startFen ?? START_FEN) && a.sans.join(' ') === b.sans.join(' ')
}

function isHistoryGame(value: unknown): value is HistoryGame {
  const g = value as Partial<HistoryGame> | null
  return typeof g?.id === 'string' && Array.isArray(g.sans) && typeof g.playedAt === 'number' && typeof g.players?.white === 'string' && typeof g.players?.black === 'string'
}

export function loadHistory(): HistoryGame[] {
  const stored = loadJson<unknown>(GAME_HISTORY_KEY, [])
  return Array.isArray(stored) ? stored.filter(isHistoryGame) : []
}

export function recordGame(game: HistoryGame): void {
  saveJson(GAME_HISTORY_KEY, [game, ...loadHistory().filter((g) => g.id !== game.id)].slice(0, MAX_GAMES))
}

/** Saves a review's accuracy on every game with these moves, since identical moves score the same. */
export function recordAccuracy(moves: GameMoves, accuracy: GameAccuracy): void {
  const games = loadHistory()
  // a King of the Hill game can have the same moves as a standard one
  const matches = (g: HistoryGame) => !g.variant && sameMoves(g, moves)
  if (!games.some(matches)) return
  saveJson(
    GAME_HISTORY_KEY,
    games.map((g) => (matches(g) ? { ...g, accuracy } : g)),
  )
}
