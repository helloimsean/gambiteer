/**
 * Drawn on top of the Board (pointer-events: none): the played move as an arrow in its
 * classification colour, the engine's best move as a green arrow when it differs, and the
 * classification badge on the destination square (chess.com style).
 *
 * Arrow geometry mirrors chessground's own arrows (1 unit = 1 square, line width 10/64,
 * arrow head 4x the line width, end shortened by 10/64) so they look like the board's arrows
 * while allowing any colour.
 */
import { useId, type CSSProperties, type JSX } from 'react'
import type { Classification, Side } from '../../api/types'
import { CLASSIFICATION_COLORS, ClassificationBadge } from '../../components/ClassificationBadge'

export interface ReviewBoardOverlayProps {
  orientation: Side
  /** UCI of the played move (null at the start position). */
  playedUci?: string | null
  classification?: Classification | null
  /** UCI of the engine's best move; drawn only when it differs from the played move. */
  bestUci?: string | null
  /** Re-trigger the badge pop animation when this changes (e.g. the ply). */
  animKey?: string | number
}

export const REVIEW_BEST_ARROW_COLOR = '#5fae32'

const FILES = 'abcdefgh'
const LINE_W = 10 / 64
const MARGIN = 10 / 64

function squareXY(sq: string, orientation: Side): { col: number; row: number } | null {
  const file = FILES.indexOf(sq[0] ?? '')
  const rank = Number(sq[1]) - 1
  if (file < 0 || !(rank >= 0 && rank < 8)) return null
  return orientation === 'white' ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank }
}

interface ArrowProps {
  uci: string
  orientation: Side
  color: string
  markerId: string
  className?: string
}

function Arrow({ uci, orientation, color, markerId, className }: ArrowProps): JSX.Element | null {
  const a = squareXY(uci.slice(0, 2), orientation)
  const b = squareXY(uci.slice(2, 4), orientation)
  if (!a || !b) return null
  const x1 = a.col + 0.5
  const y1 = a.row + 0.5
  const x2 = b.col + 0.5
  const y2 = b.row + 0.5
  const angle = Math.atan2(y2 - y1, x2 - x1)
  return (
    <g className={className}>
      <defs>
        <marker id={markerId} orient="auto" overflow="visible" markerWidth={4} markerHeight={4} refX={2.05} refY={2}>
          <path d="M0,0 V4 L3,2 Z" fill={color} />
        </marker>
      </defs>
      <line
        x1={x1}
        y1={y1}
        x2={x2 - Math.cos(angle) * MARGIN}
        y2={y2 - Math.sin(angle) * MARGIN}
        stroke={color}
        strokeWidth={LINE_W}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
    </g>
  )
}

export function ReviewBoardOverlay({ orientation, playedUci, classification, bestUci, animKey }: ReviewBoardOverlayProps): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const played = playedUci && playedUci.length >= 4 ? playedUci : null
  const best = bestUci && bestUci.length >= 4 && (!played || bestUci.slice(0, 4) !== played.slice(0, 4)) ? bestUci : null
  const playedColor = classification ? CLASSIFICATION_COLORS[classification] : '#9e9c99'
  const dest = played ? squareXY(played.slice(2, 4), orientation) : null

  return (
    <div className="review-overlay" aria-hidden="true">
      <svg className="review-overlay-svg" viewBox="0 0 8 8" preserveAspectRatio="none">
        {best ? (
          <Arrow uci={best} orientation={orientation} color={REVIEW_BEST_ARROW_COLOR} markerId={`${uid}-best`} className="review-arrow-best" />
        ) : null}
        {played ? (
          <Arrow uci={played} orientation={orientation} color={playedColor} markerId={`${uid}-played`} className="review-arrow-played" />
        ) : null}
      </svg>
      {dest && classification ? (
        <div
          key={`${animKey ?? ''}`}
          className="review-sq-badge"
          style={{ left: `${(dest.col + 1) * 12.5}%`, top: `${dest.row * 12.5}%` } as CSSProperties}
          data-testid="review-square-badge"
          data-classification={classification}
        >
          <ClassificationBadge classification={classification} size={40} />
        </div>
      ) : null}
    </div>
  )
}
