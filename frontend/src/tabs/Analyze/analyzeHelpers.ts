/** Small helpers used only by the Analyze tab. */
import { Chess, type Move } from 'chess.js'
import * as api from '../../api/client'
import { START_FEN, moveToUci } from '../../lib/chess'

/** A move sequence on the analysis board: start position + linear SAN history. */
export interface AnalyzeLine {
  startFen: string
  sans: string[]
}

export interface BuiltLine {
  /** fens[i] = position after i moves (fens[0] = startFen, normalised by chess.js). */
  fens: string[]
  /** ucis[i] = UCI of sans[i]. */
  ucis: string[]
}

/** Replay a line with chess.js. Throws on an illegal move or a bad start fen. */
export function buildLine(line: AnalyzeLine): BuiltLine {
  const chess = new Chess(line.startFen)
  const fens = [chess.fen()]
  const ucis: string[] = []
  line.sans.forEach((san, i) => {
    let mv: Move
    try {
      mv = chess.move(san)
    } catch {
      throw new Error(`Illegal move "${san}" at ply ${i + 1}`)
    }
    ucis.push(moveToUci(mv))
    fens.push(chess.fen())
  })
  return { fens, ucis }
}

/** True when `fen` is the normal initial position (move counters ignored). */
export function isInitialPosition(fen: string): boolean {
  return fen.split(' ').slice(0, 4).join(' ') === START_FEN.split(' ').slice(0, 4).join(' ')
}

/** Heuristic: a single line whose first field looks like a FEN board (8 ranks). */
export function looksLikeFen(text: string): boolean {
  const t = text.trim()
  if (!t || t.includes('\n')) return false
  const board = t.split(/\s+/)[0]
  return board.split('/').length === 8 && /^[pnbrqkPNBRQK1-8/]+$/.test(board)
}

/**
 * Validate and normalise a FEN typed by the user. Missing trailing fields are filled in
 * (" w - - 0 1" for a bare board, " 0 1" for missing counters).
 */
export function normalizeFen(input: string): { fen: string } | { error: string } {
  const parts = input.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { error: 'Enter a FEN.' }
  if (parts.length === 1) parts.push('w', '-', '-', '0', '1')
  else if (parts.length === 2) parts.push('-', '-', '0', '1')
  else if (parts.length === 3) parts.push('-', '0', '1')
  else if (parts.length === 4) parts.push('0', '1')
  else if (parts.length === 5) parts.push('1')
  const fen = parts.slice(0, 6).join(' ')
  try {
    return { fen: new Chess(fen).fen() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: msg.replace(/^(Error:\s*)?(Invalid FEN:\s*)?/i, '') || 'Invalid FEN.' }
  }
}

export interface ParsedGame {
  startFen: string
  sans: string[]
  headers: Record<string, string>
}

/**
 * Parse a PGN (or a bare move list) with the backend (`POST /api/pgn/parse`). When the backend is
 * unreachable, falls back to chess.js so importing still works offline.
 */
export async function parseGame(text: string, signal?: AbortSignal): Promise<ParsedGame> {
  try {
    const res = await api.parsePgn(text, signal)
    return { startFen: res.startFen || START_FEN, sans: res.moves.map((m) => m.san), headers: res.headers ?? {} }
  } catch (err) {
    if (!(err instanceof api.ApiError) || err.status !== 0) throw err
    const chess = new Chess()
    chess.loadPgn(text)
    const headers = chess.getHeaders()
    const startFen = headers.FEN || START_FEN
    return { startFen, sans: chess.history(), headers }
  }
}

