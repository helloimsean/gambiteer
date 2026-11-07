/** Dev-only fake data for the component playground. */
import type { EngineLine, ReviewMove } from '../api/types'
import { START_FEN } from '../lib/chess'

export const FAKE_ENGINE_LINES: EngineLine[] = [
  {
    multipv: 1,
    depth: 22,
    score: { cp: 34 },
    pv: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'],
    pvUci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7'],
  },
  {
    multipv: 2,
    depth: 22,
    score: { cp: 28 },
    pv: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'],
    pvUci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'e2e3', 'e8g8'],
  },
  {
    multipv: 3,
    depth: 21,
    score: { cp: -12 },
    pv: ['f3', 'e5', 'g4', 'Qh4#'],
    pvUci: ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
  },
  {
    multipv: 4,
    depth: 20,
    score: { mate: 3 },
    pv: ['Nf3', 'd5', 'c4'],
    pvUci: ['g1f3', 'd7d5', 'c2c4'],
  },
]

export const FAKE_REVIEW_MOVES: Pick<ReviewMove, 'ply' | 'san' | 'classification'>[] = [
  { ply: 1, san: 'e4', classification: 'book' },
  { ply: 2, san: 'Nf6', classification: 'book' },
  { ply: 3, san: 'Nc3', classification: 'book' },
  { ply: 4, san: 'd5', classification: 'book' },
  { ply: 5, san: 'e5', classification: 'best' },
  { ply: 6, san: 'Nfd7', classification: 'excellent' },
  { ply: 7, san: 'e6', classification: 'brilliant' },
  { ply: 8, san: 'fxe6', classification: 'good' },
  { ply: 9, san: 'd4', classification: 'great' },
  { ply: 10, san: 'e5', classification: 'inaccuracy' },
  { ply: 11, san: 'dxe5', classification: 'best' },
  { ply: 12, san: 'Nxe5', classification: 'blunder' },
  { ply: 13, san: 'Qh5+', classification: 'best' },
  { ply: 14, san: 'g6', classification: 'mistake' },
  { ply: 15, san: 'Qxe5', classification: 'miss' },
]

export const FAKE_SANS = FAKE_REVIEW_MOVES.map((m) => m.san)

/** White to move: b7-b8 promotes (and Black's g2 pawn promotes next). */
export const PROMOTION_TEST_FEN = '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1'
/** Both sides may castle both ways (also by dropping the king on the rook). */
export const CASTLING_TEST_FEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'
/** White to move: exd6 en passant removes the d5 pawn. */
export const EN_PASSANT_TEST_FEN = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3'
export { START_FEN }
