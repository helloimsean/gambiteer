/**
 * The chess variants of the Play tab, on chessops (the rules library lichess uses). chess.js only
 * knows standard chess, so everything here works from a variant id and a FEN.
 */
import { isDrop, makeSquare, makeUci, parseSquare, parseUci, type Move as OpsMove, type Role, type Rules } from 'chessops'
import { normalizeMove, type Position } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan, makeSanAndPlay, parseSan } from 'chessops/san'
import { setupPosition } from 'chessops/variant'
import type { Side, VariantId } from '../api/types'
import { START_FEN, type Dests, type PromotionPiece, type Square } from './chess'

export type { VariantId }

export interface VariantInfo {
  id: VariantId
  name: string
  /** The rule in one line. */
  rule: string
  rules: Rules
  /** Stockfish 19 only plays standard chess and Chess960. */
  engine: 'stockfish' | 'fairy'
  /** Antichess and Racing Kings have no checks, so Panicfish would never lose any Elo. */
  hasChecks: boolean
  /** Whether counting captured pieces against a normal army means anything. */
  hasMaterial: boolean
}

export const VARIANTS: readonly VariantInfo[] = [
  { id: 'standard', name: 'Standard', rule: 'The normal rules of chess.', rules: 'chess', engine: 'stockfish', hasChecks: true, hasMaterial: true },
  { id: 'crazyhouse', name: 'Crazyhouse', rule: 'Captured pieces can be dropped back on the board instead of moving a piece.', rules: 'crazyhouse', engine: 'fairy', hasChecks: true, hasMaterial: false },
  { id: 'chess960', name: 'Chess960', rule: 'The starting position of the home rank pieces is randomized.', rules: 'chess', engine: 'stockfish', hasChecks: true, hasMaterial: true },
  { id: 'kingofthehill', name: 'King of the Hill', rule: 'Bring your King to the center to win the game.', rules: 'kingofthehill', engine: 'fairy', hasChecks: true, hasMaterial: true },
  { id: '3check', name: 'Three-Check', rule: 'Check your opponent 3 times to win the game.', rules: '3check', engine: 'fairy', hasChecks: true, hasMaterial: true },
  { id: 'antichess', name: 'Antichess', rule: 'Lose all your pieces (or get stalemated) to win the game.', rules: 'antichess', engine: 'fairy', hasChecks: false, hasMaterial: false },
  { id: 'atomic', name: 'Atomic', rule: "Nuke your opponent's king to win.", rules: 'atomic', engine: 'fairy', hasChecks: true, hasMaterial: true },
  { id: 'horde', name: 'Horde', rule: 'One side has a large number of pawns, the other has a normal army.', rules: 'horde', engine: 'fairy', hasChecks: true, hasMaterial: false },
  { id: 'racingkings', name: 'Racing Kings', rule: 'Get your king to the other side of the board to win.', rules: 'racingkings', engine: 'fairy', hasChecks: false, hasMaterial: false },
]

export function variantInfo(id: VariantId): VariantInfo {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[0]
}

export function isVariantId(value: unknown): value is VariantId {
  return VARIANTS.some((v) => v.id === value)
}

/** One move of a game, in either rules engine. */
export interface PlayedMove {
  /** A drop's `from` is the square it lands on. */
  from: Square
  to: Square
  san: string
  uci: string
  /** It left the other king in check. */
  check: boolean
}

export type VariantWinReason = 'hill' | 'three-check' | 'explosion' | 'no-pieces' | 'stalemated' | 'horde-gone' | 'race'

export interface GameEnd {
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: VariantWinReason | 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' | 'fifty-move'
}

export interface VariantReplay {
  /** fens[i] = position after i moves. */
  fens: string[]
  moves: PlayedMove[]
  result: GameEnd | undefined
}

const FIFTY_MOVE_PLIES = 100
const CHECKS_TO_WIN = 3

function positionOf(variant: VariantId, fen: string): Position {
  return setupPosition(variantInfo(variant).rules, parseFen(fen).unwrap()).unwrap()
}

function fenOf(pos: Position): string {
  return makeFen(pos.toSetup())
}

/** Two positions repeat if everything but the move counters (the last two fields) matches. */
function repetitionKey(fen: string): string {
  return fen.split(' ').slice(0, -2).join(' ')
}

function playOn(pos: Position, move: OpsMove): PlayedMove {
  const uci = makeUci(move)
  const to = makeSquare(move.to)
  const from = isDrop(move) ? to : makeSquare(move.from)
  const san = makeSanAndPlay(pos, move)
  return { from, to, san, uci, check: pos.isCheck() }
}

const VARIANT_END_REASON: Partial<Record<VariantId, VariantWinReason>> = {
  kingofthehill: 'hill',
  '3check': 'three-check',
  atomic: 'explosion',
  antichess: 'no-pieces',
  horde: 'horde-gone',
  racingkings: 'race',
}

function endOf(variant: VariantId, pos: Position, repeats: number): GameEnd | undefined {
  const ctx = pos.ctx()
  const outcome = pos.outcome(ctx)
  if (outcome) {
    const result = outcome.winner === 'white' ? '1-0' : outcome.winner === 'black' ? '0-1' : '1/2-1/2'
    const special = pos.isVariantEnd() ? VARIANT_END_REASON[variant] : undefined
    if (special) return { result, reason: special }
    if (pos.isCheckmate(ctx)) return { result, reason: 'checkmate' }
    if (pos.isStalemate(ctx)) return { result, reason: variant === 'antichess' ? 'stalemated' : 'stalemate' }
    return { result, reason: 'insufficient' }
  }
  if (repeats >= 3) return { result: '1/2-1/2', reason: 'threefold' }
  // pieces keep coming back in Crazyhouse, so lichess has no 50-move rule there
  if (variant !== 'crazyhouse' && pos.halfmoves >= FIFTY_MOVE_PLIES) return { result: '1/2-1/2', reason: 'fifty-move' }
  return undefined
}

/** Replay a SAN list. Stops at the first illegal move. Throws on a bad start FEN. */
export function replayVariant(variant: VariantId, startFen: string, sans: readonly string[]): VariantReplay {
  const pos = positionOf(variant, startFen)
  const fens = [fenOf(pos)]
  const moves: PlayedMove[] = []
  const seen = new Map([[repetitionKey(fens[0]), 1]])
  let repeats = 1
  for (const san of sans) {
    const move = parseSan(pos, san)
    if (!move) break
    moves.push(playOn(pos, move))
    const fen = fenOf(pos)
    fens.push(fen)
    const key = repetitionKey(fen)
    repeats = (seen.get(key) ?? 0) + 1
    seen.set(key, repeats)
  }
  return { fens, moves, result: endOf(variant, pos, repeats) }
}

const ROLE_OF: Record<PromotionPiece, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', k: 'king' }

/** The move, if legal. Castling may be given as e1g1 or as king-takes-rook. */
export function variantMove(variant: VariantId, fen: string, from: Square, to: Square, promotion?: PromotionPiece): PlayedMove | null {
  const pos = positionOf(variant, fen)
  const fromSq = parseSquare(from)
  const toSq = parseSquare(to)
  if (fromSq === undefined || toSq === undefined) return null
  const move = normalizeMove(pos, { from: fromSq, to: toSq, promotion: promotion ? ROLE_OF[promotion] : undefined })
  return pos.isLegal(move) ? playOn(pos, move) : null
}

/** SAN of an engine's move in this position, or null if it is not legal here. */
export function variantUciToSan(variant: VariantId, fen: string, uci: string): string | null {
  const pos = positionOf(variant, fen)
  const parsed = parseUci(uci)
  if (!parsed) return null
  const move = normalizeMove(pos, parsed)
  return pos.isLegal(move) ? makeSan(pos, move) : null
}

export type PocketRole = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen'
export type Pocket = Record<PocketRole, number>

/** Crazyhouse: what each side can drop, or null when this FEN has no pockets. */
export function pocketsOf(fen: string): Record<Side, Pocket> | null {
  const pockets = parseFen(fen).unwrap().pockets
  if (!pockets) return null
  const side = (s: Side): Pocket => {
    const { pawn, knight, bishop, rook, queen } = pockets[s]
    return { pawn, knight, bishop, rook, queen }
  }
  return { white: side('white'), black: side('black') }
}

export function variantDrop(variant: VariantId, fen: string, role: PocketRole, to: Square): PlayedMove | null {
  const pos = positionOf(variant, fen)
  const toSq = parseSquare(to)
  if (toSq === undefined) return null
  const move = { role, to: toSq }
  return pos.isLegal(move) ? playOn(pos, move) : null
}

/** Three-Check: how many checks each side has given, or null in other variants. */
export function checksGiven(fen: string): Record<Side, number> | null {
  const remaining = parseFen(fen).unwrap().remainingChecks
  return remaining ? { white: CHECKS_TO_WIN - remaining.white, black: CHECKS_TO_WIN - remaining.black } : null
}

/** What the board needs to know about a position chess.js cannot read. */
export interface BoardRules {
  dests: Dests
  check: boolean
  isPromotion: (from: Square, to: Square) => boolean
  /** Antichess lets a pawn become a king. */
  kingPromotion: boolean
}

export function boardRulesFor(variant: VariantId, fen: string): BoardRules {
  const pos = positionOf(variant, fen)
  const dests = chessgroundDests(pos, { chess960: variant === 'chess960' }) as Dests
  return {
    dests,
    check: pos.isCheck(),
    kingPromotion: variant === 'antichess',
    isPromotion: (from, to) => {
      const sq = parseSquare(from)
      return sq !== undefined && pos.board.getRole(sq) === 'pawn' && /[18]$/.test(to) && Boolean(dests.get(from)?.includes(to))
    },
  }
}

function chess960Rank(): string {
  const rank: string[] = Array.from({ length: 8 }, () => '')
  const pick = (squares: readonly number[]): number => squares[Math.floor(Math.random() * squares.length)]
  const empty = (): number[] => rank.flatMap((piece, i) => (piece ? [] : [i]))
  rank[pick([0, 2, 4, 6])] = 'b'
  rank[pick([1, 3, 5, 7])] = 'b'
  rank[pick(empty())] = 'q'
  rank[pick(empty())] = 'n'
  rank[pick(empty())] = 'n'
  const [left, middle, right] = empty()
  rank[left] = 'r'
  rank[middle] = 'k'
  rank[right] = 'r'
  return rank.join('')
}

const VARIANT_START: Partial<Record<VariantId, string>> = {
  crazyhouse: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1',
  '3check': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1',
  antichess: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
  horde: 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1',
  racingkings: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
}

/** Where a new game starts. Chess960 draws a fresh position every time. */
export function variantStartFen(variant: VariantId): string {
  if (variant === 'chess960') {
    const rank = chess960Rank()
    return `${rank}/pppppppp/8/8/8/8/PPPPPPPP/${rank.toUpperCase()} w KQkq - 0 1`
  }
  return VARIANT_START[variant] ?? START_FEN
}
