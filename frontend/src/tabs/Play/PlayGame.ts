/**
 * Play tab: game model, persistence and pure helpers (no React in here).
 *
 * A game is stored as a SAN list from `startFen` (always the initial position today, kept for
 * future "start from FEN" support). Everything else (fens, last move, status) is derived by
 * replaying the list with chess.js, which also gives threefold-repetition detection for free.
 */
import { Chess } from 'chess.js'
import type { BotStrength, LineMeta, OpeningFull, Players, Side } from '../../api/types'
import type { LastGame, ReviewRequestPayload } from '../../state/AppContext'
import { START_FEN, gameStatus, oppositeSide, turnFromFen, type Move } from '../../lib/chess'
import { loadJson, saveJson } from '../../lib/storage'

// ---------------------------------------------------------------- constants

/** localStorage: the game in progress (or the last finished one), so a tab switch or reload keeps it. */
export const PLAY_GAME_KEY = 'play-game-v1'
/** localStorage: the last values of the new-game dialog. */
export const PLAY_SETUP_KEY = 'play-setup-v1'

export const ELO_MIN = 400
export const ELO_MAX = 3190
/** From this Elo up the backend uses Stockfish's own UCI_LimitStrength/UCI_Elo. */
export const UCI_ELO_MIN = 1320
export const ELO_PRESETS = [800, 1200, 1500, 2000, 2500, 3190] as const
export const MOVETIME_OPTIONS = [300, 800, 2000] as const
/** Delay before the bot plays a book move from the line (feels less robotic than instant). */
export const BOOK_MOVE_DELAY_MS = 450
/** How long the engine hint arrow stays on the board. */
export const HINT_DURATION_MS = 3000
export const HINT_DEPTH = 12
/** Value of the line select meaning "pick a random line when the game starts". */
export const RANDOM_LINE = '__random__'

// ---------------------------------------------------------------- types

export type ColorChoice = Side | 'random'
/** "end": the game starts after the whole line. "hints": the line is played out with book feedback. */
export type OpeningMode = 'end' | 'hints'

export interface PlaySetup {
  color: ColorChoice
  elo: number
  movetimeMs: number
  useOpening: boolean
  openingId: string
  /** A line id or {@link RANDOM_LINE}. */
  lineId: string
  openingMode: OpeningMode
}

export const DEFAULT_SETUP: PlaySetup = {
  color: 'white',
  elo: 1200,
  movetimeMs: 800,
  useOpening: false,
  openingId: '',
  lineId: RANDOM_LINE,
  openingMode: 'hints',
}

/** "check" = the student found the book move; "book" = a move from the line (bot or pre-played). */
export type MoveMark = 'check' | 'book'

export interface PlayOpening {
  id: string
  name: string
  /** The side the repertoire is written for. */
  side: Side
  /** Line chosen when the game started (used by Rematch). */
  startLineId: string
  /** Line currently followed. In hints mode it switches when the student picks another book move. */
  lineId: string
  lineName: string
  lineSans: string[]
  mode: OpeningMode
}

export type GameReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'draw'
  | 'resignation'

export interface GameResult {
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: GameReason
}

export interface PlayGame {
  version: 1
  /** Unique per game; async bot replies check it so they never land in a newer game. */
  id: string
  studentColor: Side
  elo: number
  movetimeMs: number
  startFen: string
  /** Every move from `startFen`, including a pre-played opening line. */
  sans: string[]
  /** Plies that cannot be taken back (the pre-played line in "end" mode). */
  basePly: number
  /** Per-move marks for the move list, keyed by ply (1-based, relative to startFen). */
  marks: Record<number, MoveMark>
  opening?: PlayOpening
  bookStats: { correct: number; missed: number }
  result?: GameResult
  startedAt: number
  endedAt?: number
}

// ---------------------------------------------------------------- replay

export interface Replay {
  /** fens[i] = position after i moves (fens[0] = startFen). */
  fens: string[]
  moves: Move[]
  /** chess.js instance at the final position (with history, so repetition detection works). */
  chess: Chess
}

/** Replay a SAN list. Stops at the first illegal move (the result then has fewer moves). */
export function replayGame(startFen: string, sans: readonly string[]): Replay {
  const chess = new Chess(startFen)
  const fens = [chess.fen()]
  const moves: Move[] = []
  for (const san of sans) {
    try {
      moves.push(chess.move(san))
    } catch {
      break
    }
    fens.push(chess.fen())
  }
  return { fens, moves, chess }
}

/** Game result from the rules (mate, stalemate, insufficient material, 50-move, threefold), or undefined. */
export function ruleResult(chess: Chess): GameResult | undefined {
  const st = gameStatus(chess)
  return st.over ? { result: st.result, reason: st.reason } : undefined
}

/** Side that played ply `ply` (1-based) in a game starting at `startFen`. */
export function moverOfPly(startFen: string, ply: number): Side {
  const first = turnFromFen(startFen)
  return ply % 2 === 1 ? first : oppositeSide(first)
}

/** Append a move (SAN, must be legal) and detect the end of the game. */
export function withMove(game: PlayGame, san: string, mark?: MoveMark, patch?: Partial<PlayGame>): PlayGame {
  const sans = [...game.sans, san]
  const marks = { ...game.marks }
  if (mark) marks[sans.length] = mark
  const next: PlayGame = { ...game, ...patch, sans, marks }
  const result = ruleResult(replayGame(game.startFen, sans).chess)
  if (result) {
    next.result = result
    next.endedAt = Date.now()
  }
  return next
}

/**
 * Number of plies to keep for a takeback: back to the position before the student's last move
 * (so normally both plies, only one while the bot is still thinking). Null when nothing can be
 * taken back.
 */
export function takebackTarget(game: PlayGame): number | null {
  for (let ply = game.sans.length; ply > game.basePly; ply--) {
    if (moverOfPly(game.startFen, ply) === game.studentColor) return ply - 1
  }
  return null
}

/** Truncate the game to `plies` moves (takeback). */
export function truncateGame(game: PlayGame, plies: number): PlayGame {
  const marks: Record<number, MoveMark> = {}
  for (const [k, v] of Object.entries(game.marks)) {
    if (Number(k) <= plies) marks[Number(k)] = v
  }
  return { ...game, sans: game.sans.slice(0, plies), marks, result: undefined, endedAt: undefined }
}

export function resignGame(game: PlayGame): PlayGame {
  return {
    ...game,
    result: { result: game.studentColor === 'white' ? '0-1' : '1-0', reason: 'resignation' },
    endedAt: Date.now(),
  }
}

// ---------------------------------------------------------------- book (hints mode)

export interface BookState {
  /** Leading plies of the game that follow the active line. */
  followed: number
  /** The game still follows the line and the line has more moves. */
  inBook: boolean
  /** Next move of the line when in book. */
  expected: string | null
  /** The whole line was played. */
  completed: boolean
  /** The game left the line before its end. */
  left: boolean
}

export function bookState(game: PlayGame | null): BookState | null {
  const o = game?.opening
  if (!game || !o || o.mode !== 'hints') return null
  let followed = 0
  while (followed < game.sans.length && followed < o.lineSans.length && game.sans[followed] === o.lineSans[followed]) {
    followed += 1
  }
  const inBook = followed === game.sans.length && followed < o.lineSans.length
  const completed = followed === o.lineSans.length
  return {
    followed,
    inBook,
    expected: inBook ? o.lineSans[followed] : null,
    completed,
    left: !inBook && !completed,
  }
}

/**
 * The student played `san` instead of the active line's move: if it is another book move of the
 * opening (a different line through the same position), return the line to switch to.
 */
export function alternativeBookLine(full: OpeningFull | null | undefined, sans: readonly string[], san: string): LineMeta | null {
  if (!full) return null
  const path = [...sans, san]
  const candidates = full.lines.filter((l) => l.sans.length > sans.length && path.every((s, i) => l.sans[i] === s))
  if (candidates.length === 0) return null
  // prefer the main line, then the longest line
  candidates.sort((a, b) => Number(b.category === 'main') - Number(a.category === 'main') || b.sans.length - a.sans.length)
  return candidates[0]
}

// ---------------------------------------------------------------- labels

export function botName(): string {
  return 'Stockfish 19'
}

/** Caption under the Elo slider (contract wording from ARCHITECTURE.md). */
export function strengthCaption(elo: number): string {
  return elo >= UCI_ELO_MIN ? 'Stockfish 19, UCI_Elo' : 'approximate (Skill Level + mixing)'
}

/** Rough human description of an Elo. */
export function eloLevel(elo: number): string {
  if (elo < 800) return 'Beginner'
  if (elo < 1100) return 'Novice'
  if (elo < 1400) return 'Intermediate'
  if (elo < 1700) return 'Club player'
  if (elo < 2000) return 'Advanced'
  if (elo < 2200) return 'Expert'
  if (elo < 2500) return 'Master'
  if (elo < 2800) return 'Grandmaster'
  return 'Full strength'
}

/** What the backend reported about the strength it used. */
export function strengthDetail(s: BotStrength | null, elo: number): string {
  if (!s) return elo >= UCI_ELO_MIN ? `UCI_Elo ${elo}` : `approx. ${elo} (Skill Level + mixing)`
  if (s.mode === 'uci_elo') return `UCI_Elo ${s.elo}`
  return `Skill Level ${s.skill ?? '?'} + mixing (approx. ${s.elo})`
}

export function formatMovetime(ms: number): string {
  return `${ms / 1000} s`
}

export type Outcome = 'win' | 'loss' | 'draw'

export function outcomeFor(game: PlayGame): Outcome | null {
  if (!game.result) return null
  if (game.result.result === '1/2-1/2') return 'draw'
  const whiteWon = game.result.result === '1-0'
  return whiteWon === (game.studentColor === 'white') ? 'win' : 'loss'
}

export function reasonText(reason: GameReason): string {
  switch (reason) {
    case 'checkmate':
      return 'by checkmate'
    case 'stalemate':
      return 'by stalemate'
    case 'insufficient':
      return 'by insufficient material'
    case 'threefold':
      return 'by threefold repetition'
    case 'fifty-move':
      return 'by the 50-move rule'
    case 'draw':
      return 'by the rules'
    case 'resignation':
      return 'by resignation'
  }
}

/** "You won by checkmate", "Stockfish 19 won by resignation", "Draw by stalemate". */
export function resultHeadline(game: PlayGame): string {
  const o = outcomeFor(game)
  if (!o || !game.result) return ''
  const how = reasonText(game.result.reason)
  if (o === 'draw') return `Draw ${how}`
  return o === 'win' ? `You won ${how}` : `${botName()} won ${how}`
}

export function gamePlayers(game: PlayGame): Players {
  const bot = `${botName()} (${game.elo})`
  return game.studentColor === 'white' ? { white: 'You', black: bot } : { white: bot, black: 'You' }
}

export function toLastGame(game: PlayGame): LastGame {
  return {
    sans: [...game.sans],
    ...(game.startFen !== START_FEN ? { startFen: game.startFen } : {}),
    players: gamePlayers(game),
    result: game.result?.result ?? '*',
    reason: game.result?.reason,
    playedAt: game.endedAt ?? Date.now(),
  }
}

export function toReviewRequest(game: PlayGame): ReviewRequestPayload {
  return {
    sans: [...game.sans],
    players: gamePlayers(game),
    ...(game.startFen !== START_FEN ? { startFen: game.startFen } : {}),
  }
}

// ---------------------------------------------------------------- creation

export function newGameId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function resolveColor(choice: ColorChoice): Side {
  if (choice !== 'random') return choice
  return Math.random() < 0.5 ? 'white' : 'black'
}

/**
 * Build a new game from the dialog values. `full` must be the loaded opening when
 * `setup.useOpening` is on. Throws a readable Error when the setup cannot be used.
 */
export function createGame(setup: PlaySetup, full: OpeningFull | null): PlayGame {
  const studentColor = resolveColor(setup.color)
  let opening: PlayOpening | undefined
  let sans: string[] = []
  const marks: Record<number, MoveMark> = {}
  if (setup.useOpening) {
    if (!full) throw new Error('The opening is still loading.')
    if (full.lines.length === 0) throw new Error(`${full.name} has no lines.`)
    const line =
      setup.lineId === RANDOM_LINE || !setup.lineId
        ? full.lines[Math.floor(Math.random() * full.lines.length)]
        : full.lines.find((l) => l.id === setup.lineId)
    if (!line) throw new Error('That line no longer exists in this opening.')
    const replay = replayGame(START_FEN, line.sans)
    if (replay.moves.length !== line.sans.length) throw new Error(`Line "${line.name}" contains an illegal move.`)
    opening = {
      id: full.id,
      name: full.name,
      side: full.side,
      startLineId: line.id,
      lineId: line.id,
      lineName: line.name,
      lineSans: [...line.sans],
      mode: setup.openingMode,
    }
    if (setup.openingMode === 'end') {
      sans = [...line.sans]
      sans.forEach((_, i) => {
        marks[i + 1] = 'book'
      })
    }
  }
  const game: PlayGame = {
    version: 1,
    id: newGameId(),
    studentColor,
    elo: clampElo(setup.elo),
    movetimeMs: setup.movetimeMs,
    startFen: START_FEN,
    sans,
    basePly: sans.length,
    marks,
    opening,
    bookStats: { correct: 0, missed: 0 },
    startedAt: Date.now(),
  }
  const result = ruleResult(replayGame(game.startFen, sans).chess)
  if (result) {
    game.result = result
    game.endedAt = Date.now()
  }
  return game
}

/** Dialog values for a rematch: same settings; colours swapped unless the game used an opening line. */
export function rematchSetup(game: PlayGame, current: PlaySetup): PlaySetup {
  return {
    ...current,
    color: game.opening ? game.studentColor : oppositeSide(game.studentColor),
    elo: game.elo,
    movetimeMs: game.movetimeMs,
    useOpening: Boolean(game.opening),
    openingId: game.opening?.id ?? current.openingId,
    lineId: game.opening?.startLineId ?? current.lineId,
    openingMode: game.opening?.mode ?? current.openingMode,
  }
}

export function clampElo(elo: number): number {
  if (!Number.isFinite(elo)) return DEFAULT_SETUP.elo
  return Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(elo)))
}

// ---------------------------------------------------------------- persistence

export function loadSetup(): PlaySetup {
  const s = loadJson<Record<string, unknown> | null>(PLAY_SETUP_KEY, null)
  const out: PlaySetup = { ...DEFAULT_SETUP }
  if (!s || typeof s !== 'object') return out
  if (s.color === 'white' || s.color === 'black' || s.color === 'random') out.color = s.color
  if (typeof s.elo === 'number') out.elo = clampElo(s.elo)
  if (typeof s.movetimeMs === 'number' && (MOVETIME_OPTIONS as readonly number[]).includes(s.movetimeMs)) out.movetimeMs = s.movetimeMs
  if (typeof s.useOpening === 'boolean') out.useOpening = s.useOpening
  if (typeof s.openingId === 'string') out.openingId = s.openingId
  if (typeof s.lineId === 'string') out.lineId = s.lineId
  if (s.openingMode === 'end' || s.openingMode === 'hints') out.openingMode = s.openingMode
  return out
}

export function saveSetup(setup: PlaySetup): void {
  saveJson(PLAY_SETUP_KEY, setup)
}

function isSide(v: unknown): v is Side {
  return v === 'white' || v === 'black'
}

/** Load the saved game, validating its shape and dropping an illegal tail. Null when absent or broken. */
export function loadSavedGame(): PlayGame | null {
  const g = loadJson<Partial<PlayGame> | null>(PLAY_GAME_KEY, null)
  if (!g || typeof g !== 'object' || g.version !== 1) return null
  if (typeof g.id !== 'string' || !isSide(g.studentColor) || !Array.isArray(g.sans)) return null
  const startFen = typeof g.startFen === 'string' ? g.startFen : START_FEN
  let replay: Replay
  try {
    replay = replayGame(
      startFen,
      g.sans.filter((s): s is string => typeof s === 'string'),
    )
  } catch {
    return null // bad start fen
  }
  const sans = replay.moves.map((m) => m.san)
  const marks: Record<number, MoveMark> = {}
  if (g.marks && typeof g.marks === 'object') {
    for (const [k, v] of Object.entries(g.marks)) {
      const ply = Number(k)
      if ((v === 'check' || v === 'book') && ply >= 1 && ply <= sans.length) marks[ply] = v
    }
  }
  let opening: PlayOpening | undefined
  const o = g.opening
  if (o && typeof o === 'object' && typeof o.id === 'string' && Array.isArray(o.lineSans)) {
    opening = {
      id: o.id,
      name: typeof o.name === 'string' ? o.name : o.id,
      side: isSide(o.side) ? o.side : g.studentColor,
      startLineId: typeof o.startLineId === 'string' ? o.startLineId : String(o.lineId ?? ''),
      lineId: typeof o.lineId === 'string' ? o.lineId : '',
      lineName: typeof o.lineName === 'string' ? o.lineName : '',
      lineSans: o.lineSans.filter((s): s is string => typeof s === 'string'),
      mode: o.mode === 'end' ? 'end' : 'hints',
    }
  }
  const game: PlayGame = {
    version: 1,
    id: g.id,
    studentColor: g.studentColor,
    elo: clampElo(typeof g.elo === 'number' ? g.elo : DEFAULT_SETUP.elo),
    movetimeMs: typeof g.movetimeMs === 'number' && g.movetimeMs > 0 ? g.movetimeMs : DEFAULT_SETUP.movetimeMs,
    startFen,
    sans,
    basePly: typeof g.basePly === 'number' ? Math.min(Math.max(0, g.basePly), sans.length) : 0,
    marks,
    opening,
    bookStats: {
      correct: typeof g.bookStats?.correct === 'number' ? g.bookStats.correct : 0,
      missed: typeof g.bookStats?.missed === 'number' ? g.bookStats.missed : 0,
    },
    startedAt: typeof g.startedAt === 'number' ? g.startedAt : Date.now(),
  }
  // the result is re-derived from the rules; a resignation is kept as stored
  const rules = ruleResult(replay.chess)
  if (rules) game.result = rules
  else if (g.result && g.result.reason === 'resignation') game.result = g.result
  if (game.result) game.endedAt = typeof g.endedAt === 'number' ? g.endedAt : Date.now()
  return game
}

export function saveGame(game: PlayGame | null): void {
  saveJson(PLAY_GAME_KEY, game)
}
