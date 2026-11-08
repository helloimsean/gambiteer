import { useEffect, useRef, type JSX } from 'react'
import { moveNumberPrefix } from '../../lib/chess'
import { scrollIntoViewWithin } from '../../lib/dom'
import type { ReviewVariation } from './useReviewVariation'

export interface ReviewVariationLineProps {
  variation: ReviewVariation
  /** Absolute ply of the position the line starts from. */
  startPly: number
  onSelect: (index: number) => void
}

/** The tried moves, indented under their row of the move list: "5. exd5 e4 6. Nd4 O-O". */
export function ReviewVariationLine({ variation, startPly, onSelect }: ReviewVariationLineProps): JSX.Element {
  const currentRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    scrollIntoViewWithin(currentRef.current, currentRef.current?.closest<HTMLElement>('.move-list') ?? null)
  }, [variation.index, variation.moves.length])

  return (
    <div className="review-variation" data-testid="review-variation">
      {variation.moves.map((move, i) => {
        const ply = startPly + i + 1
        const current = i + 1 === variation.index
        return (
          <button
            key={move.id}
            ref={current ? currentRef : undefined}
            type="button"
            className={`review-var-move${current ? ' current' : ''}`}
            onClick={() => onSelect(i + 1)}
            data-testid="review-var-move"
          >
            {ply % 2 === 1 || i === 0 ? <span className="review-var-num">{moveNumberPrefix(ply)}</span> : null}
            {move.san}
          </button>
        )
      })}
    </div>
  )
}
