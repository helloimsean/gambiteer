/**
 * Eval graph of a reviewed game (chess.com style): White's advantage as a light area rising from
 * the bottom, centipawns clipped to +-8 pawns and mate drawn at +-10. Key moments are dots in their
 * classification colour; the current ply has a marker. Click (or drag) to jump to a ply.
 */
import { useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { ReviewResult } from '../../api/types'
import { CLASSIFICATION_COLORS, ClassificationBadge } from '../../components/ClassificationBadge'
import { moveNumberPrefix } from '../../lib/chess'
import { formatScore } from '../../lib/eval'
import { GRAPH_MATE, graphValues, isKeyMoment, reviewPlyOffset } from './reviewUtils'

export interface ReviewEvalGraphProps {
  result: ReviewResult
  /** Current ply (0 = start). */
  ply: number
  onSelect: (ply: number) => void
  /** Pixel height. Default 84. */
  height?: number
}

const PAD_X = 4
const PAD_Y = 3

export function ReviewEvalGraph({ result, ply, onSelect, height = 84 }: ReviewEvalGraphProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const draggingRef = useRef(false)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setWidth(Math.round(el.getBoundingClientRect().width))
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const values = useMemo(() => graphValues(result), [result])
  const n = result.moves.length
  const offset = reviewPlyOffset(result)
  const H = height
  const innerW = Math.max(1, width - 2 * PAD_X)
  const x = (i: number) => PAD_X + (n === 0 ? 0 : (i * innerW) / n)
  const y = (v: number) => H / 2 - (v / GRAPH_MATE) * (H / 2 - PAD_Y)

  let areaPath = ''
  let linePath = ''
  if (width > 0 && values.length > 0) {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    areaPath = `M${x(0).toFixed(1)},${H} L${pts.join(' L')} L${x(values.length - 1).toFixed(1)},${H} Z`
    linePath = `M${pts.join(' L')}`
  }

  const plyFromEvent = (e: ReactPointerEvent<SVGSVGElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (n === 0) return 0
    const i = Math.round(((px - PAD_X) / innerW) * n)
    return Math.max(0, Math.min(n, i))
  }

  const hoverMove = hover !== null && hover > 0 ? result.moves[hover - 1] : null
  const hoverScore = hover === null ? null : hover === 0 ? result.moves[0]?.evalBefore : result.moves[hover - 1]?.evalAfter
  const tooltipLeft = hover === null ? 0 : Math.max(60, Math.min(width - 60, x(hover)))

  return (
    <div className="review-graph" ref={wrapRef} style={{ height: H }} data-testid="review-graph">
      {width > 0 ? (
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="slider"
          aria-label="Evaluation graph: click to jump to a move"
          aria-valuemin={0}
          aria-valuemax={n}
          aria-valuenow={ply}
          onPointerDown={(e) => {
            draggingRef.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            const p = plyFromEvent(e)
            setHover(p)
            onSelect(p)
          }}
          onPointerMove={(e) => {
            const p = plyFromEvent(e)
            setHover(p)
            if (draggingRef.current && p !== ply) onSelect(p)
          }}
          onPointerUp={(e) => {
            draggingRef.current = false
            e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onPointerLeave={() => {
            if (!draggingRef.current) setHover(null)
          }}
        >
          <rect x={0} y={0} width={width} height={H} className="review-graph-bg" />
          <path d={areaPath} className="review-graph-area" />
          <line x1={0} x2={width} y1={H / 2} y2={H / 2} className="review-graph-mid" />
          <path d={linePath} className="review-graph-line" />
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="review-graph-hover" /> : null}
          <line x1={x(ply)} x2={x(ply)} y1={0} y2={H} className="review-graph-cursor" />
          {result.moves.map((m) =>
            isKeyMoment(m.classification) ? (
              <circle
                key={m.ply}
                cx={x(m.ply)}
                cy={y(values[m.ply] ?? 0)}
                r={m.ply === ply ? 5 : 3.6}
                fill={CLASSIFICATION_COLORS[m.classification]}
                className="review-graph-dot"
              />
            ) : null,
          )}
          <circle cx={x(ply)} cy={y(values[ply] ?? 0)} r={4} className="review-graph-cursor-dot" />
        </svg>
      ) : null}
      {hover !== null && hoverScore ? (
        <div className="review-graph-tip" style={{ left: tooltipLeft }}>
          {hoverMove ? (
            <>
              <ClassificationBadge classification={hoverMove.classification} size={14} />
              <span className="bold">
                {moveNumberPrefix(offset + hoverMove.ply)}
                {hoverMove.san}
              </span>
            </>
          ) : (
            <span className="bold">Start</span>
          )}
          <span className="mono">{formatScore(hoverScore)}</span>
        </div>
      ) : null}
    </div>
  )
}
