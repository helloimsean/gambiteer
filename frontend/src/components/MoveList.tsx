import { Fragment, useEffect, useRef, type JSX, type ReactNode } from 'react'
import { scrollIntoViewWithin } from '../lib/dom'
import { t } from '../lib/i18n'
import './MoveList.css'

export interface MoveListProps {
  /** SAN moves in order. */
  moves: readonly string[]
  /**
   * Current ply, 0..moves.length where 0 = the start position (nothing highlighted).
   * Ply `i` means "after moves[i-1]".
   */
  currentPly: number
  onSelect?: (ply: number) => void
  /**
   * Ply number of the position BEFORE moves[0] (default 0). Set it when the move list does not
   * start from the initial position (e.g. 8 when the game started after 4 full moves).
   */
  startPly?: number
  /** Optional badge per move (e.g. a ClassificationBadge). `ply` is 1-based as above. */
  renderBadge?: (ply: number, san: string) => ReactNode
  /**
   * Shown right after move `afterPly` (1-based as above), such as a side line. A row is split around
   * it when that move is White's, so Black's reply continues on the row below.
   */
  insert?: { afterPly: number; node: ReactNode }
  /** Keep the current move scrolled into view. Default true. */
  autoScroll?: boolean
  emptyText?: string
  className?: string
}

/** Numbered move pairs with the current move highlighted; click a move to jump to it. */
export function MoveList({
  moves,
  currentPly,
  onSelect,
  startPly = 0,
  renderBadge,
  insert,
  autoScroll = true,
  emptyText = t('No moves yet'),
  className,
}: MoveListProps): JSX.Element {
  const currentRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!autoScroll) return
    if (currentPly === 0 && containerRef.current) containerRef.current.scrollTop = 0
    else scrollIntoViewWithin(currentRef.current, containerRef.current)
  }, [currentPly, autoScroll, moves.length])

  if (moves.length === 0) {
    return (
      <div className={`move-list${className ? ` ${className}` : ''}`} ref={containerRef}>
        <div className="move-list-empty">{emptyText}</div>
      </div>
    )
  }

  // Build rows of (white, black). The absolute ply of moves[i] is startPly + i + 1.
  const rows: { num: number; white: number | null; black: number | null }[] = []
  for (let i = 0; i < moves.length; i++) {
    const ply = startPly + i + 1
    const num = Math.ceil(ply / 2)
    const isWhite = ply % 2 === 1
    const last = rows[rows.length - 1]
    if (isWhite || !last || last.num !== num) {
      rows.push({ num, white: isWhite ? i : null, black: isWhite ? null : i })
    } else {
      last.black = i
    }
  }

  const cell = (idx: number | null) => {
    if (idx === null) return <span className="move-cell empty">…</span>
    const ply = idx + 1 // relative ply used by currentPly / onSelect
    const san = moves[idx]
    const isCurrent = ply === currentPly
    return (
      <button
        ref={isCurrent ? currentRef : undefined}
        type="button"
        className={`move-cell${isCurrent ? ' current' : ''}`}
        data-ply={ply}
        onClick={() => onSelect?.(ply)}
      >
        <span className="move-san">{san}</span>
        {renderBadge ? <span className="move-badge">{renderBadge(ply, san)}</span> : null}
      </button>
    )
  }

  const row = (num: number, white: number | null, black: number | null) => (
    <div className="move-row">
      <span className="move-num">{num}.</span>
      {cell(white)}
      {cell(black)}
    </div>
  )
  const insertIdx = insert ? insert.afterPly - 1 : null

  return (
    <div className={`move-list${className ? ` ${className}` : ''}`} ref={containerRef}>
      {rows.map((r) => {
        if (insertIdx === null || (r.white !== insertIdx && r.black !== insertIdx)) return <Fragment key={r.num}>{row(r.num, r.white, r.black)}</Fragment>
        const split = r.white === insertIdx && r.black !== null
        return (
          <Fragment key={r.num}>
            {split ? row(r.num, r.white, null) : row(r.num, r.white, r.black)}
            {insert?.node}
            {split ? row(r.num, null, r.black) : null}
          </Fragment>
        )
      })}
    </div>
  )
}
