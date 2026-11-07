import type { CSSProperties, JSX } from 'react'
import type { Score, Side } from '../api/types'
import { evalBarWhiteShare, formatScore, mateWinner } from '../lib/eval'
import './EvalBar.css'

export interface EvalBarProps {
  /** White-POV score as returned by the API. `null`/`undefined` shows a neutral bar without a label. */
  score: Score | null | undefined
  /** Which side is at the bottom of the board next to the bar. Default "white". */
  orientation?: Side
  /** Position the score belongs to; lets `{ mate: 0 }` (checkmate on the board) fill the bar for the winner. */
  fen?: string
  /** Show the "1.3" / "M3" label. Default true. */
  showLabel?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * Vertical evaluation bar (chess.com style). The white part is White's win% share (from the
 * bottom when White is at the bottom); the unsigned label sits at the leading side's end.
 * Height follows the parent (100%), so put it next to the board in a flex row.
 */
export function EvalBar({ score, orientation = 'white', fen, showLabel = true, className, style }: EvalBarProps): JSX.Element {
  const whiteShare = evalBarWhiteShare(score, fen)
  const winner = score ? mateWinner(score, fen) : null
  const whiteAhead = winner !== null && winner !== 0 ? winner > 0 : whiteShare >= 0.5
  const label = formatScore(score, 'white')
  const whiteAtBottom = orientation === 'white'
  const labelAtBottom = whiteAhead === whiteAtBottom
  const labelText = !score ? '' : label === '#' ? (whiteAhead ? '1-0' : '0-1') : label.replace(/^[+-]/, '')

  return (
    <div
      className={`eval-bar ${whiteAtBottom ? 'white-bottom' : 'white-top'}${className ? ` ${className}` : ''}`}
      style={style}
      title={score ? `Evaluation ${label} (White's point of view)` : 'No evaluation'}
      data-score={label}
    >
      <div className="eval-bar-white" style={{ height: `${(whiteShare * 100).toFixed(2)}%` }} />
      <div className="eval-bar-mid" />
      {showLabel && score ? (
        <span className={`eval-bar-label ${labelAtBottom ? 'bottom' : 'top'} ${whiteAhead ? 'on-white' : 'on-black'}`}>
          {labelText}
        </span>
      ) : null}
    </div>
  )
}
