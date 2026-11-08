/**
 * chess.js helpers shared by every tab.
 *
 * Terminology: a "SAN path" is an array of SAN moves from a start position
 * (the normal initial position unless stated otherwise), e.g. ["e4","Nf6","Nc3"].
 * A "ply" is a half-move; ply 1 is 1.e4, ply 2 is 1...Nf6.
 */
import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js'
import type { Side } from '../api/types'

export type { Move, PieceSymbol, Square }
/** 'k' only exists in Antichess. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n' | 'k'
export type CgColor = 'white' | 'black'
export type Dests = Map<Square, Square[]>

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const PIECE_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Build a Chess instance from a FEN, throwing a readable error on an invalid FEN. */
export function chessFromFen(fen: string): Chess {
  return new Chess(fen)
}

/** `true` when chess.js accepts the FEN. */
export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen)
    return true
  } catch {
    return false
  }
}

/** Side to move for a FEN ("white" | "black"). */
export function turnFromFen(fen: string): Side {
  const turn = fen.split(' ')[1]
  return turn === 'b' ? 'black' : 'white'
}

export function colorToSide(c: 'w' | 'b'): Side {
  return c === 'w' ? 'white' : 'black'
}

export function sideToColor(s: Side): 'w' | 'b' {
  return s === 'white' ? 'w' : 'b'
}

export function oppositeSide(s: Side): Side {
  return s === 'white' ? 'black' : 'white'
}

export interface DestsOptions {
  /**
   * Also allow castling by dropping the king on its own rook (e1->h1 for O-O), as on chess.com and
   * lichess. Such a move must be passed through {@link normalizeCastlingMove} before chess.js sees it
   * (the Board component does this for you). Default false.
   */
  rookCastle?: boolean
}

function addDest(dests: Dests, from: Square, to: Square): void {
  const list = dests.get(from)
  if (list) {
    if (!list.includes(to)) list.push(to)
  } else dests.set(from, [to])
}

/** Legal destinations per origin square, in the shape chessground expects for `movable.dests`. */
export function toDests(chess: Chess, opts: DestsOptions = {}): Dests {
  const dests: Dests = new Map()
  for (const m of chess.moves({ verbose: true })) {
    addDest(dests, m.from, m.to)
    if (opts.rookCastle && (m.flags.includes('k') || m.flags.includes('q'))) {
      const rank = m.from[1]
      addDest(dests, m.from, `${m.flags.includes('k') ? 'h' : 'a'}${rank}` as Square)
    }
  }
  return dests
}

/** Same as {@link toDests} but from a FEN string; returns an empty map for an invalid FEN. */
export function destsFromFen(fen: string, opts: DestsOptions = {}): Dests {
  try {
    return toDests(new Chess(fen), opts)
  } catch {
    return new Map()
  }
}

/**
 * Map a "king takes own rook" castling gesture (e1h1, e1a1, e8h8, e8a8) to the chess.js / UCI form
 * (e1g1, e1c1, ...). Any other move is returned unchanged.
 */
export function normalizeCastlingMove(fen: string, from: Square, to: Square): { from: Square; to: Square } {
  try {
    const chess = new Chess(fen)
    const piece = chess.get(from)
    const target = chess.get(to)
    if (
      piece?.type === 'k' &&
      target?.type === 'r' &&
      target.color === piece.color &&
      from[1] === to[1] &&
      from[0] === 'e' &&
      (to[0] === 'h' || to[0] === 'a')
    ) {
      return { from, to: `${to[0] === 'h' ? 'g' : 'c'}${from[1]}` as Square }
    }
  } catch {
    /* invalid fen: leave the move alone */
  }
  return { from, to }
}

/** Is `from -> to` a pawn promotion in this position? (Ignores legality of the move otherwise.) */
export function isPromotion(fen: string, from: Square, to: Square): boolean {
  try {
    const chess = new Chess(fen)
    const piece = chess.get(from)
    if (!piece || piece.type !== 'p') return false
    const rank = to[1]
    return (piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1')
  } catch {
    return false
  }
}

/** "e7e8q" -> { from, to, promotion }. Throws on malformed input. */
export function parseUci(uci: string): { from: Square; to: Square; promotion?: PromotionPiece } {
  if (uci.length < 4) throw new Error(`Bad UCI move: "${uci}"`)
  const from = uci.slice(0, 2) as Square
  const to = uci.slice(2, 4) as Square
  const promo = uci.slice(4, 5).toLowerCase()
  const promotion = promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n' ? promo : undefined
  return { from, to, promotion }
}

/** chess.js Move -> UCI ("e2e4", "e7e8q"). */
export function moveToUci(m: Move): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`
}

/**
 * Apply a SAN path to a fresh board (or `startFen`). Throws a descriptive error naming the
 * offending ply when a move is illegal.
 */
export function applySanPath(sans: readonly string[], startFen: string = START_FEN): Chess {
  const chess = new Chess(startFen)
  sans.forEach((san, i) => {
    try {
      chess.move(san)
    } catch {
      throw new Error(`Illegal move "${san}" at ply ${i + 1} (after ${sans.slice(0, i).join(' ')})`)
    }
  })
  return chess
}

/**
 * FENs along a SAN path. `fens[0]` is the start position, `fens[i]` the position after `i` moves,
 * so the result has `sans.length + 1` entries. Throws on an illegal move.
 */
export function sanPathToFens(sans: readonly string[], startFen: string = START_FEN): string[] {
  const chess = new Chess(startFen)
  const fens = [chess.fen()]
  sans.forEach((san, i) => {
    try {
      chess.move(san)
    } catch {
      throw new Error(`Illegal move "${san}" at ply ${i + 1}`)
    }
    fens.push(chess.fen())
  })
  return fens
}

/** Verbose moves along a SAN path (gives you from/to/uci/fen before+after per ply). */
export function sanPathToMoves(sans: readonly string[], startFen: string = START_FEN): Move[] {
  const chess = new Chess(startFen)
  return sans.map((san, i) => {
    try {
      return chess.move(san)
    } catch {
      throw new Error(`Illegal move "${san}" at ply ${i + 1}`)
    }
  })
}

/** Convert one UCI move to SAN in the given position. Returns null if illegal. */
export function uciToSan(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen)
    const { from, to, promotion } = parseUci(uci)
    return chess.move({ from, to, promotion }).san
  } catch {
    return null
  }
}

/** Convert one SAN move to UCI in the given position. Returns null if illegal. */
export function sanToUci(fen: string, san: string): string | null {
  try {
    const chess = new Chess(fen)
    return moveToUci(chess.move(san))
  } catch {
    return null
  }
}

/** Convert a UCI sequence (e.g. an engine PV) to SAN, stopping at the first illegal move. */
export function uciPathToSans(ucis: readonly string[], startFen: string = START_FEN): string[] {
  const chess = new Chess(startFen)
  const out: string[] = []
  for (const u of ucis) {
    try {
      const { from, to, promotion } = parseUci(u)
      out.push(chess.move({ from, to, promotion }).san)
    } catch {
      break
    }
  }
  return out
}

/** Convert a mixed UCI/SAN move list to SAN (useful for /api/review inputs and PGN imports). */
export function normalizeToSans(moves: readonly string[], startFen: string = START_FEN): string[] {
  const chess = new Chess(startFen)
  const out: string[] = []
  for (const mv of moves) {
    let played: Move | null = null
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(mv)) {
      try {
        const { from, to, promotion } = parseUci(mv)
        played = chess.move({ from, to, promotion })
      } catch {
        played = null
      }
    }
    if (!played) {
      try {
        played = chess.move(mv)
      } catch {
        throw new Error(`Illegal move "${mv}" at ply ${out.length + 1}`)
      }
    }
    out.push(played.san)
  }
  return out
}

/** Try a move and return the resulting chess.js Move (or null if illegal), leaving `chess` unchanged. */
export function tryMove(
  fen: string,
  from: Square,
  to: Square,
  promotion?: PromotionPiece,
): Move | null {
  try {
    const chess = new Chess(fen)
    return chess.move({ from, to, promotion })
  } catch {
    return null
  }
}

/** The square of the king of the side to move if it is in check, else null. */
export function checkedKingSquare(fen: string): Square | null {
  try {
    const chess = new Chess(fen)
    if (!chess.inCheck()) return null
    const sq = chess.findPiece({ type: 'k', color: chess.turn() })
    return sq[0] ?? null
  } catch {
    return null
  }
}

export type GameStatus =
  | { over: false }
  | { over: true; result: '1-0' | '0-1' | '1/2-1/2'; reason: 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' | 'fifty-move' | 'draw' }

/** Game-over detection with the standard result string. */
export function gameStatus(chess: Chess): GameStatus {
  if (chess.isCheckmate()) return { over: true, result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' }
  if (chess.isStalemate()) return { over: true, result: '1/2-1/2', reason: 'stalemate' }
  if (chess.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient' }
  if (chess.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'threefold' }
  if (chess.isDrawByFiftyMoves()) return { over: true, result: '1/2-1/2', reason: 'fifty-move' }
  if (chess.isDraw()) return { over: true, result: '1/2-1/2', reason: 'draw' }
  return { over: false }
}

/** "1." for ply 1, "1..." for ply 2, "2." for ply 3 ... */
export function moveNumberPrefix(ply: number): string {
  const n = Math.ceil(ply / 2)
  return ply % 2 === 1 ? `${n}.` : `${n}...`
}

/** Pretty "1.e4 Nf6 2.Nc3" string for a SAN path; `numberGap` " " gives PGN's "1. e4". */
export function formatSanPath(sans: readonly string[], startPly = 0, numberGap = ''): string {
  const parts: string[] = []
  sans.forEach((san, i) => {
    const ply = startPly + i + 1
    if (ply % 2 === 1) parts.push(`${Math.ceil(ply / 2)}.${numberGap}${san}`)
    else if (i === 0) parts.push(`${Math.ceil(ply / 2)}...${numberGap}${san}`)
    else parts.push(san)
  })
  return parts.join(' ')
}

export interface MaterialInfo {
  /** Pieces each side has captured, as piece symbols sorted by value desc (e.g. ["q","n","p","p"]). */
  captured: { white: PieceSymbol[]; black: PieceSymbol[] }
  /** Positive = White is up material (in pawns). */
  diff: number
}

const START_COUNTS: Record<PieceSymbol, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 }

/** Captured pieces + material difference for a FEN (relative to the standard starting army). */
export function materialInfo(fen: string): MaterialInfo {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } }
  const board = fen.split(' ')[0] ?? ''
  for (const ch of board) {
    const lower = ch.toLowerCase() as PieceSymbol
    if (!(lower in START_COUNTS)) continue
    counts[ch === lower ? 'b' : 'w'][lower] += 1
  }
  const order: PieceSymbol[] = ['q', 'r', 'b', 'n', 'p']
  const missing = (c: 'w' | 'b'): PieceSymbol[] => {
    const out: PieceSymbol[] = []
    for (const p of order) {
      const n = Math.max(0, START_COUNTS[p] - counts[c][p])
      for (let i = 0; i < n; i++) out.push(p)
    }
    return out
  }
  // what White captured = Black's missing pieces
  const whiteCaptured = missing('b')
  const blackCaptured = missing('w')
  const value = (c: 'w' | 'b') => order.reduce((s, p) => s + counts[c][p] * PIECE_VALUES[p], 0)
  return { captured: { white: whiteCaptured, black: blackCaptured }, diff: value('w') - value('b') }
}

/** Build a minimal PGN movetext from SAN moves (+ optional headers / result). */
export function sansToPgn(
  sans: readonly string[],
  opts: { headers?: Record<string, string>; result?: string; startFen?: string } = {},
): string {
  const headers: string[] = []
  const h = { ...(opts.headers ?? {}) }
  if (opts.startFen && opts.startFen !== START_FEN) {
    h.SetUp = '1'
    h.FEN = opts.startFen
  }
  for (const [k, v] of Object.entries(h)) headers.push(`[${k} "${v.replace(/"/g, '\\"')}"]`)
  const body = formatSanPath(sans, opts.startFen ? plyOffsetFromFen(opts.startFen) : 0, ' ')
  const result = opts.result ?? '*'
  return `${headers.length ? headers.join('\n') + '\n\n' : ''}${body}${body ? ' ' : ''}${result}\n`
}

/** Number of plies already played according to a FEN's move counters (0 for the start position). */
export function plyOffsetFromFen(fen: string): number {
  const parts = fen.split(' ')
  const turn = parts[1] ?? 'w'
  // the last field, because a Three-Check FEN has an extra one
  const moveNo = Number(parts.length >= 6 ? parts[parts.length - 1] : '1')
  return (moveNo - 1) * 2 + (turn === 'b' ? 1 : 0)
}
