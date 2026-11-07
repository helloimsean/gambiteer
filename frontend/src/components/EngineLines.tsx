import type { JSX } from 'react'
import type { EngineLine } from '../api/types'
import { plyOffsetFromFen } from '../lib/chess'
import { formatScore, scoreToCp } from '../lib/eval'
import { Spinner } from './Spinner'
import './EngineLines.css'

export interface EngineLinesProps {
  /** MultiPV lines (White-POV scores). */
  lines: readonly EngineLine[]
  /** Position the lines belong to; used for move numbering. */
  fen: string
  /**
   * Click handler for a PV move: `line` and the index of the move within `line.pv`.
   * A tab typically plays `line.pv.slice(0, index + 1)` on its board.
   */
  onSelectMove?: (line: EngineLine, index: number) => void
  /** Header info (optional). */
  depth?: number
  nodes?: number
  nps?: number
  engineName?: string
  /** Shows a spinner in the header and dims the rows. */
  thinking?: boolean
  /** Max PV moves to render per line (default 12). */
  maxPvMoves?: number
  emptyText?: string
  className?: string
}

function fmtBig(n: number | undefined): string {
  if (n === undefined) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

/** MultiPV rows: score pill, depth, PV in SAN with move numbers. */
export function EngineLines({
  lines,
  fen,
  onSelectMove,
  depth,
  nodes,
  nps,
  engineName,
  thinking,
  maxPvMoves = 12,
  emptyText = 'Engine is off',
  className,
}: EngineLinesProps): JSX.Element {
  const startPly = plyOffsetFromFen(fen)
  const showHead = depth !== undefined || nodes !== undefined || engineName || thinking
  const sorted = [...lines].sort((a, b) => a.multipv - b.multipv)

  return (
    <div className={`engine-lines${className ? ` ${className}` : ''}`}>
      {showHead ? (
        <div className="engine-head">
          {thinking ? <Spinner size={12} /> : null}
          {engineName ? <span className="bold">{engineName}</span> : null}
          {depth !== undefined ? <span className="mono">depth {depth}</span> : null}
          {nodes !== undefined ? <span className="mono">{fmtBig(nodes)} nodes</span> : null}
          {nps !== undefined ? <span className="mono">{fmtBig(nps)} n/s</span> : null}
        </div>
      ) : null}
      {sorted.length === 0 ? <div className="engine-empty">{emptyText}</div> : null}
      {sorted.map((line) => {
        const cp = scoreToCp(line.score, 'white')
        return (
          <div className={`engine-line${thinking ? ' loading' : ''}`} key={line.multipv}>
            <span className={`engine-score${cp < 0 ? ' black' : ''}`}>{formatScore(line.score, 'white')}</span>
            <span className="engine-depth" title="Depth">
              d{line.depth}
            </span>
            <span className="engine-pv">
              {line.pv.slice(0, maxPvMoves).map((san, i) => {
                const ply = startPly + i + 1
                const num = Math.ceil(ply / 2)
                const isWhite = ply % 2 === 1
                return (
                  <span key={i} className="row gap-4">
                    {isWhite ? <span className="pv-num">{num}.</span> : i === 0 ? <span className="pv-num">{num}…</span> : null}
                    <button
                      type="button"
                      className={`pv-move${onSelectMove ? '' : ' static'}`}
                      onClick={onSelectMove ? () => onSelectMove(line, i) : undefined}
                      tabIndex={onSelectMove ? 0 : -1}
                    >
                      {san}
                    </button>
                  </span>
                )
              })}
              {line.pv.length > maxPvMoves ? <span className="pv-num">…</span> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}
