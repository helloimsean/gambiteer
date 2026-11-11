/**
 * Play tab: game model, persistence and pure helpers (no React in here).
 *
 * A game is stored as a SAN list from `startFen`. Everything else (fens, last move, status, and
 * Panicfish's remaining Elo) is derived by replaying the list: with chess.js for standard chess,
 * with chessops for the variants (see lib/variants.ts).
 */
import { Chess } from 'chess.js'
import type { BotKind, BotStrength, Health, LineMeta, OpeningFull, Players, Side, VariantId } from '../../api/types'
import type { HistoryGame } from '../../lib/gameHistory'
import type { LastGame } from '../../state/AppContext'
import { START_FEN, gameStatus, moveToUci, oppositeSide, tryMove, turnFromFen, uciToSan, type PromotionPiece, type Square } from '../../lib/chess'
import { loadJson, saveJson } from '../../lib/storage'
import { t } from '../../lib/i18n'
import {
  isVariantId,
  replayVariant,
  variantInfo,
  variantMove,
  variantStartFen,
  variantUciToSan,
  type PlayedMove,
  type VariantWinReason,
} from '../../lib/variants'

// ---------------------------------------------------------------- constants

/** localStorage: the game in progress (or the last finished one), so a tab switch or reload keeps it. */
export const PLAY_GAME_KEY = 'play-game-v1'
/** localStorage: the last values of the new-game dialog. */
export const PLAY_SETUP_KEY = 'play-setup-v1'

export const ELO_MIN = 400
export const ELO_MAX = 3190
/** From this Elo up the backend uses Stockfish's own UCI_LimitStrength/UCI_Elo. */
export const UCI_ELO_MIN = 1320
const FAIRY_UCI_ELO_MIN = 500
export const ELO_PRESETS = [800, 1200, 1500, 2000, 2500, 3190] as const
export const MAIA_ELO_MIN = 1100
export const MAIA_ELO_MAX = 1900
/** Maia has one trained net per 100 rating points. */
export const MAIA_ELO_STEP = 100
export const MAIA_ELO_PRESETS = [1100, 1300, 1500, 1700, 1900] as const
export const PANICFISH_START_ELO = 3600
export const PANICFISH_ELO_PER_CHECK = 300
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
  variant: VariantId
  color: ColorChoice
  bot: BotKind
  /** Stockfish's Elo. */
  elo: number
  /** Maia's rating, kept apart from `elo` so switching bots loses neither. */
  maiaElo: number
  movetimeMs: number
  useOpening: boolean
  openingId: string
  /** A line id or {@link RANDOM_LINE}. */
  lineId: string
  openingMode: OpeningMode
}

export const DEFAULT_SETUP: PlaySetup = {
  variant: 'standard',
  color: 'white',
  bot: 'stockfish',
  elo: 1200,
  maiaElo: 1500,
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
  | VariantWinReason

export interface GameResult {
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: GameReason
}

export interface PlayGame {
  version: 1
  /** Unique per game; async bot replies check it so they never land in a newer game. */
  id: string
  variant: VariantId
  studentColor: Side
  bot: BotKind
  /** The bot's Elo (Stockfish), rating (Maia) or starting Elo (Panicfish: see {@link botEloNow}). */
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
  moves: PlayedMove[]
  /** The result by the rules, once the game is over. */
  result: GameResult | undefined
}

/** Replay a SAN list. Stops at the first illegal move (the result then has fewer moves). */
export function replayGame(startFen: string, sans: readonly string[], variant: VariantId = 'standard'): Replay {
  if (variant !== 'standard') return replayVariant(variant, startFen, sans)
  const chess = new Chess(startFen)
  const fens = [chess.fen()]
  const moves: PlayedMove[] = []
  for (const san of sans) {
    try {
      const m = chess.move(san)
      moves.push({ from: m.from, to: m.to, san: m.san, uci: moveToUci(m), check: /[+#]$/.test(m.san) })
    } catch {
      break
    }
    fens.push(chess.fen())
  }
  const st = gameStatus(chess)
  return { fens, moves, result: st.over ? { result: st.result, reason: st.reason } : undefined }
}

/** The move as the student tried it, if legal. */
export function legalMove(variant: VariantId, fen: string, from: Square, to: Square, promotion?: PromotionPiece): { san: string } | null {
  return variant === 'standard' ? tryMove(fen, from, to, promotion) : variantMove(variant, fen, from, to, promotion)
}

/** SAN of the engine's move, or null if it is not legal here. */
export function sanOfEngineMove(variant: VariantId, fen: string, uci: string): string | null {
  return variant === 'standard' ? uciToSan(fen, uci) : variantUciToSan(variant, fen, uci)
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
  const { result } = replayGame(game.startFen, sans, game.variant)
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

export function botName(bot: BotKind, variant: VariantId = 'standard'): string {
  if (bot === 'maia') return 'Maia'
  if (bot === 'panicfish') return 'Panicfish'
  return variantInfo(variant).engine === 'fairy' ? 'Fairy-Stockfish' : 'Stockfish 19'
}

/** "Stockfish 19 (1200)", "Maia (1500)". */
export function botTitle(bot: BotKind, elo: number, variant: VariantId = 'standard'): string {
  return `${botName(bot, variant)} (${elo})`
}

/** Caption under the Elo slider (contract wording from ARCHITECTURE.md). */
export function strengthCaption(bot: BotKind, elo: number, variant: VariantId = 'standard'): string {
  if (bot === 'maia') return t('Maia {elo}, trained on Lichess players rated about {elo}', { elo })
  const lowestLimit = variantInfo(variant).engine === 'fairy' ? FAIRY_UCI_ELO_MIN : UCI_ELO_MIN
  return elo >= lowestLimit
    ? t('{bot}, limited to this Elo', { bot: botName(bot, variant) })
    : t('{bot}, roughly this Elo', { bot: botName(bot, variant) })
}

/** Panicfish loses Elo for every check the student has given it. */
export function panicfishElo(checks: number): number {
  return Math.max(0, PANICFISH_START_ELO - PANICFISH_ELO_PER_CHECK * checks)
}

/** The strength the bot has right now. Only Panicfish's changes during a game. */
export function botEloNow(game: PlayGame, moves: readonly PlayedMove[]): number {
  if (game.bot !== 'panicfish') return game.elo
  return panicfishElo(moves.filter((m, i) => m.check && moverOfPly(game.startFen, i + 1) === game.studentColor).length)
}

export function currentElo(game: PlayGame): number {
  return botEloNow(game, replayGame(game.startFen, game.sans, game.variant).moves)
}

export function panicfishMood(elo: number): string {
  if (elo >= PANICFISH_START_ELO) return t('Full strength. Every check costs it {per} Elo.', { per: PANICFISH_ELO_PER_CHECK })
  return elo > 0 ? t('Down to {elo} Elo and losing its nerve.', { elo }) : t('Out of Elo. It now plays random moves.')
}

/** Rough human description of an Elo. */
export function eloLevel(elo: number): string {
  if (elo < 800) return t('Beginner')
  if (elo < 1100) return t('Novice')
  if (elo < 1400) return t('Intermediate')
  if (elo < 1700) return t('Club player')
  if (elo < 2000) return t('Advanced')
  if (elo < 2200) return t('Expert')
  if (elo < 2500) return t('Master')
  if (elo < 2800) return t('Grandmaster')
  return t('Full strength')
}

/** What the backend reported about the strength it used. */
export function strengthDetail(bot: BotKind, s: BotStrength | null, elo: number): string {
  if (bot === 'maia') return strengthCaption(bot, s?.elo ?? elo)
  if (bot === 'panicfish') return panicfishMood(elo)
  const shown = s?.elo ?? elo
  const exact = s ? s.mode === 'uci_elo' : elo >= UCI_ELO_MIN
  return exact ? t('Limited to {elo} Elo', { elo: shown }) : t('About {elo} Elo (approximate)', { elo: shown })
}

export function formatMovetime(ms: number): string {
  return t('{seconds} s', { seconds: ms / 1000 })
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
      return t('by checkmate')
    case 'stalemate':
      return t('by stalemate')
    case 'insufficient':
      return t('by insufficient material')
    case 'threefold':
      return t('by threefold repetition')
    case 'fifty-move':
      return t('by the 50-move rule')
    case 'draw':
      return t('by the rules')
    case 'resignation':
      return t('by resignation')
    case 'hill':
      return t('by reaching the center')
    case 'three-check':
      return t('by giving three checks')
    case 'explosion':
      return t('by blowing up the king')
    case 'no-pieces':
      return t('by losing every piece')
    case 'stalemated':
      return t('by getting stalemated')
    case 'horde-gone':
      return t('by capturing the whole horde')
    case 'race':
      return t('by reaching the last rank')
  }
}

/** "You won by checkmate", "Stockfish 19 won by resignation", "Draw by stalemate". */
export function resultHeadline(game: PlayGame): string {
  const o = outcomeFor(game)
  if (!o || !game.result) return ''
  const how = reasonText(game.result.reason)
  if (o === 'draw') return t('Draw {how}', { how })
  return o === 'win' ? t('You won {how}', { how }) : t('{bot} won {how}', { bot: botName(game.bot, game.variant), how })
}

export function gamePlayers(game: PlayGame): Players {
  const bot = botTitle(game.bot, currentElo(game), game.variant)
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

export function toHistoryGame(game: PlayGame): HistoryGame {
  return {
    ...toLastGame(game),
    id: game.id,
    bot: game.bot,
    elo: currentElo(game),
    studentColor: game.studentColor,
    players: gamePlayers(game),
    result: game.result?.result ?? '*',
    ...(game.variant !== 'standard' ? { variant: game.variant } : {}),
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
export function createGame(chosen: PlaySetup, full: OpeningFull | null): PlayGame {
  const setup = fitToVariant(chosen)
  const studentColor = resolveColor(setup.color)
  let opening: PlayOpening | undefined
  let sans: string[] = []
  const marks: Record<number, MoveMark> = {}
  if (setup.useOpening) {
    if (!full) throw new Error(t('The opening is still loading.'))
    if (full.lines.length === 0) throw new Error(t('{name} has no lines.', { name: full.name }))
    const line =
      setup.lineId === RANDOM_LINE || !setup.lineId
        ? full.lines[Math.floor(Math.random() * full.lines.length)]
        : full.lines.find((l) => l.id === setup.lineId)
    if (!line) throw new Error(t('That line no longer exists in this opening.'))
    const replay = replayGame(START_FEN, line.sans)
    if (replay.moves.length !== line.sans.length) throw new Error(t('Line "{name}" contains an illegal move.', { name: line.name }))
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
    variant: setup.variant,
    studentColor,
    bot: setup.bot,
    elo: setupElo(setup),
    movetimeMs: setup.movetimeMs,
    startFen: variantStartFen(setup.variant),
    sans,
    basePly: sans.length,
    marks,
    opening,
    bookStats: { correct: 0, missed: 0 },
    startedAt: Date.now(),
  }
  const { result } = replayGame(game.startFen, sans, game.variant)
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
    variant: game.variant,
    color: game.opening ? game.studentColor : oppositeSide(game.studentColor),
    bot: game.bot,
    ...(game.bot === 'maia' ? { maiaElo: game.elo } : game.bot === 'stockfish' ? { elo: game.elo } : {}),
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

/** The nearest rating Maia has a net for. */
export function clampMaiaElo(elo: number): number {
  if (!Number.isFinite(elo)) return DEFAULT_SETUP.maiaElo
  const stepped = Math.round(elo / MAIA_ELO_STEP) * MAIA_ELO_STEP
  return Math.min(MAIA_ELO_MAX, Math.max(MAIA_ELO_MIN, stepped))
}

/** The strength a new game from this setup is played at. */
export function setupElo(setup: PlaySetup): number {
  if (setup.bot === 'panicfish') return PANICFISH_START_ELO
  return setup.bot === 'maia' ? clampMaiaElo(setup.maiaElo) : clampElo(setup.elo)
}

// ---------------------------------------------------------------- variants and availability

/** Only Black has a king in Horde, so Panicfish could only be checked if it plays Black. */
export function colorIsLocked(setup: Pick<PlaySetup, 'variant' | 'bot'>): boolean {
  return setup.variant === 'horde' && setup.bot === 'panicfish'
}

/**
 * What a variant allows: opening lines and Maia are standard chess only, and Panicfish needs checks.
 * The stored choices are left alone, so they come back when the variant is switched back.
 */
export function fitToVariant(setup: PlaySetup): PlaySetup {
  const standard = setup.variant === 'standard'
  const bot = (setup.bot === 'maia' && !standard) || (setup.bot === 'panicfish' && !variantInfo(setup.variant).hasChecks) ? 'stockfish' : setup.bot
  const useOpening = standard && setup.useOpening
  const color = colorIsLocked({ variant: setup.variant, bot }) ? 'white' : setup.color
  return bot === setup.bot && useOpening === setup.useOpening && color === setup.color ? setup : { ...setup, bot, useOpening, color }
}

export type FairyStatus = 'unknown' | 'available' | 'missing'

export function fairyStatusOf(health: Health | null): FairyStatus {
  if (!health) return 'unknown'
  return health.fairy?.available ? 'available' : 'missing'
}

/** The variant needs Fairy-Stockfish and it is not installed. */
export function variantBlocked(variant: VariantId, status: FairyStatus): boolean {
  return variantInfo(variant).engine === 'fairy' && status === 'missing'
}

// ---------------------------------------------------------------- Maia availability

/** Can Maia be played? "unknown" until /api/health has answered, so nothing flashes "not installed". */
export type MaiaStatus = 'unknown' | 'available' | 'missing'

export function maiaStatusOf(health: Health | null): MaiaStatus {
  if (!health) return 'unknown'
  return health.maia?.available ? 'available' : 'missing' // an older backend does not report Maia
}

/** The ratings with an installed net, or null when that is not known (then all of them are offered). */
export function maiaRatingsOf(health: Health | null): readonly number[] | null {
  return health?.maia?.ratings ?? null
}

/** Whether a game at this strength can get replies on this install. */
export function botCanPlay(bot: BotKind, elo: number, status: MaiaStatus, ratings: readonly number[] | null): boolean {
  if (bot !== 'maia') return true
  return status !== 'missing' && (ratings === null || ratings.includes(elo))
}

function nearestRating(elo: number, ratings: readonly number[]): number {
  return ratings.reduce((best, r) => (Math.abs(r - elo) < Math.abs(best - elo) ? r : best))
}

/**
 * The setup the form shows and a new game uses: a stored choice of Maia that cannot be played
 * becomes Stockfish, and a rating whose net is missing becomes the nearest installed one. The
 * stored values are not changed, so the choice returns once Maia is fully installed.
 */
export function playableSetup(chosen: PlaySetup, status: MaiaStatus, ratings: readonly number[] | null): PlaySetup {
  const setup = fitToVariant(chosen)
  if (setup.bot !== 'maia') return setup
  if (status === 'missing') return { ...setup, bot: 'stockfish' }
  const rating = clampMaiaElo(setup.maiaElo)
  if (!ratings || ratings.length === 0 || ratings.includes(rating)) return setup
  return { ...setup, maiaElo: nearestRating(rating, ratings) }
}

// ---------------------------------------------------------------- persistence

export function loadSetup(): PlaySetup {
  const s = loadJson<Record<string, unknown> | null>(PLAY_SETUP_KEY, null)
  const out: PlaySetup = { ...DEFAULT_SETUP }
  if (!s || typeof s !== 'object') return out
  if (isVariantId(s.variant)) out.variant = s.variant
  if (s.color === 'white' || s.color === 'black' || s.color === 'random') out.color = s.color
  if (s.bot === 'stockfish' || s.bot === 'maia' || s.bot === 'panicfish') out.bot = s.bot
  if (typeof s.elo === 'number') out.elo = clampElo(s.elo)
  if (typeof s.maiaElo === 'number') out.maiaElo = clampMaiaElo(s.maiaElo)
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
  const variant: VariantId = isVariantId(g.variant) ? g.variant : 'standard' // games saved before the variants have none
  let replay: Replay
  try {
    replay = replayGame(
      startFen,
      g.sans.filter((s): s is string => typeof s === 'string'),
      variant,
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
  const bot: BotKind = g.bot === 'maia' || g.bot === 'panicfish' ? g.bot : 'stockfish' // games saved before Maia have no `bot`
  const savedElo = typeof g.elo === 'number' ? g.elo : NaN
  const game: PlayGame = {
    version: 1,
    id: g.id,
    variant,
    studentColor: g.studentColor,
    bot,
    elo: bot === 'maia' ? clampMaiaElo(savedElo) : bot === 'panicfish' ? PANICFISH_START_ELO : clampElo(savedElo),
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
  if (replay.result) game.result = replay.result
  else if (g.result && g.result.reason === 'resignation') game.result = g.result
  if (game.result) game.endedAt = typeof g.endedAt === 'number' ? g.endedAt : Date.now()
  return game
}

export function saveGame(game: PlayGame | null): void {
  saveJson(PLAY_GAME_KEY, game)
}
