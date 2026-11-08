/**
 * Game report pieces: the accuracy header (both players, big numbers), the classification count
 * table with badges for both sides, and the summary (opening, engine, key moments).
 */
import type { JSX, ReactNode } from 'react'
import type { Classification, Players, ReviewResult, Side } from '../../api/types'
import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS, ClassificationBadge } from '../../components/ClassificationBadge'
import { Icon } from '../../components/Icon'
import { moveNumberPrefix } from '../../lib/chess'
import { formatScore } from '../../lib/eval'
import { REVIEW_TABLE_ORDER, formatAccuracy, isKeyMoment, reviewPlyOffset, sideName } from './reviewUtils'

// ---------------------------------------------------------------- accuracy header

export interface ReviewAccuracyHeaderProps {
  result: ReviewResult
  players?: Players
  gameResult?: string
  onNew: () => void
  /** Shown along the bottom of the header (the PGN export buttons). */
  actions?: ReactNode
}

export function ReviewAccuracyHeader({ result, players, gameResult, onNew, actions }: ReviewAccuracyHeaderProps): JSX.Element {
  return (
    <div className="panel review-header" data-testid="review-header">
      <div className="panel-header">
        <Icon name="review" size={18} />
        <span className="panel-title">Game Review</span>
        <span className="small dim" title="Engine and depth used for this review">
          {result.engine} · depth {result.depth}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNew} title="Review another game" data-testid="review-new">
          <Icon name="plus" size={14} /> New
        </button>
      </div>
      <div className="review-players">
        <PlayerAccuracy side="white" name={sideName(players, 'white')} accuracy={result.accuracy.white} />
        <div className="review-players-mid">
          <span className="review-acc-caption">Accuracy</span>
          {gameResult && gameResult !== '*' ? <span className="review-game-result">{gameResult}</span> : null}
        </div>
        <PlayerAccuracy side="black" name={sideName(players, 'black')} accuracy={result.accuracy.black} />
      </div>
      {actions ? <div className="review-export">{actions}</div> : null}
    </div>
  )
}

function PlayerAccuracy({ side, name, accuracy }: { side: Side; name: string; accuracy: number }): JSX.Element {
  return (
    <div className={`review-player review-player-${side}`}>
      <div className="review-player-name truncate" title={name}>
        <span className={`review-player-dot ${side}`} />
        {name}
      </div>
      <div className={`review-acc-box ${side}`} data-testid={`review-accuracy-${side}`}>
        {formatAccuracy(accuracy)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- counts table + summary

export interface ReviewSummaryProps {
  result: ReviewResult
  players?: Players
  /** Jump to a ply (and show the move details). */
  onJump: (ply: number) => void
  /** Currently selected ply, so repeated clicks on a count cycle through its moves. */
  ply: number
}

export function ReviewSummary({ result, players, onJump, ply }: ReviewSummaryProps): JSX.Element {
  const offset = reviewPlyOffset(result)
  const keyMoments = result.moves.filter((m) => isKeyMoment(m.classification))

  /** Next move of that colour + classification after the current ply (wrapping). */
  const jumpTo = (side: Side, cls: Classification) => {
    const list = result.moves.filter((m) => m.color === side && m.classification === cls).map((m) => m.ply)
    if (list.length === 0) return
    onJump(list.find((p) => p > ply) ?? list[0])
  }

  return (
    <div className="review-summary" data-testid="review-summary">
      <table className="review-counts" data-testid="review-counts">
        <thead>
          <tr>
            <th />
            <th className="review-count-head" title={sideName(players, 'white')}>
              <div className="review-count-head-inner">
                <span className="review-player-dot white" />
                <span className="truncate">{sideName(players, 'white')}</span>
              </div>
            </th>
            <th />
            <th className="review-count-head" title={sideName(players, 'black')}>
              <div className="review-count-head-inner">
                <span className="review-player-dot black" />
                <span className="truncate">{sideName(players, 'black')}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {REVIEW_TABLE_ORDER.map((cls) => {
            const w = result.counts.white[cls] ?? 0
            const b = result.counts.black[cls] ?? 0
            const color = CLASSIFICATION_COLORS[cls]
            return (
              <tr key={cls} data-classification={cls}>
                <td className="review-count-label" style={{ color: w + b > 0 ? color : undefined }}>
                  {CLASSIFICATION_LABELS[cls]}
                </td>
                <td>
                  <button
                    type="button"
                    className={`review-count${w > 0 ? '' : ' zero'}`}
                    style={{ color: w > 0 ? color : undefined }}
                    disabled={w === 0}
                    onClick={() => jumpTo('white', cls)}
                    title={w > 0 ? `Show White's ${CLASSIFICATION_LABELS[cls].toLowerCase()} moves` : undefined}
                  >
                    {w}
                  </button>
                </td>
                <td className="review-count-badge">
                  <ClassificationBadge classification={cls} size={22} />
                </td>
                <td>
                  <button
                    type="button"
                    className={`review-count${b > 0 ? '' : ' zero'}`}
                    style={{ color: b > 0 ? color : undefined }}
                    disabled={b === 0}
                    onClick={() => jumpTo('black', cls)}
                    title={b > 0 ? `Show Black's ${CLASSIFICATION_LABELS[cls].toLowerCase()} moves` : undefined}
                  >
                    {b}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {result.opening ? (
        <div className="review-opening">
          <ClassificationBadge classification="book" size={18} />
          <div>
            <div className="bold">{result.opening.name}</div>
            <div className="small muted">
              In your repertoire until {moveNumberPrefix(offset + result.opening.lastBookPly)}
              {result.moves[result.opening.lastBookPly - 1]?.san ?? ''}
            </div>
          </div>
        </div>
      ) : null}

      <div className="review-moments">
        <h4>Key moments</h4>
        {keyMoments.length === 0 ? (
          <div className="small muted">No inaccuracies, mistakes, blunders or standout moves in this game.</div>
        ) : (
          <div className="review-moment-list">
            {keyMoments.map((m) => (
              <button
                key={m.ply}
                type="button"
                className={`review-moment${m.ply === ply ? ' current' : ''}`}
                onClick={() => onJump(m.ply)}
                data-ply={m.ply}
              >
                <ClassificationBadge classification={m.classification} size={18} />
                <span className="review-moment-move">
                  {moveNumberPrefix(offset + m.ply)}
                  {m.san}
                </span>
                <span className="review-moment-label" style={{ color: CLASSIFICATION_COLORS[m.classification] }}>
                  {CLASSIFICATION_LABELS[m.classification]}
                </span>
                <span className="spacer" />
                <span className="mono small muted">
                  {formatScore(m.evalBefore)} → {formatScore(m.evalAfter)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
