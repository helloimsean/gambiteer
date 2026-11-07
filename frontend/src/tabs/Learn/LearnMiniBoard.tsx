/**
 * LearnMiniBoard: a tiny static board for the gallery cards. Much lighter than a chessground
 * instance per card: a CSS checkerboard plus the cburnett piece sprites, which chessground's CSS
 * keys on literal `<piece>` elements inside `.cg-wrap` (created imperatively so React does not
 * warn about the unknown tag).
 */
import { useLayoutEffect, useRef, type JSX } from 'react'
import type { Side } from '../../api/types'

const ROLES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const FILES = 'abcdefgh'

export interface LearnMiniBoardProps {
  fen: string
  orientation: Side
  /** [from, to] squares to highlight. */
  lastMove?: readonly [string, string] | null
  /** Pixel size (square). */
  size?: number
}

/** Board coordinates (0..7 from the left, 0..7 from the top) of a square for an orientation. */
function squareXY(square: string, orientation: Side): { x: number; y: number } {
  const file = FILES.indexOf(square[0])
  const rank = Number(square[1]) - 1
  return orientation === 'white' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank }
}

export function LearnMiniBoard({ fen, orientation, lastMove, size = 112 }: LearnMiniBoardProps): JSX.Element {
  const piecesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = piecesRef.current
    if (!host) return
    const created: HTMLElement[] = []
    const rows = fen.split(' ')[0].split('/')
    rows.forEach((row, i) => {
      let file = 0
      for (const ch of row) {
        if (/\d/.test(ch)) {
          file += Number(ch)
          continue
        }
        const role = ROLES[ch.toLowerCase()]
        if (role) {
          const color = ch === ch.toUpperCase() ? 'white' : 'black'
          const { x, y } = squareXY(`${FILES[file]}${8 - i}`, orientation)
          const el = document.createElement('piece')
          el.className = `${role} ${color}`
          el.style.transform = `translate(${x * 100}%, ${y * 100}%)`
          host.appendChild(el)
          created.push(el)
        }
        file += 1
      }
    })
    return () => created.forEach((el) => el.remove())
  }, [fen, orientation])

  return (
    <div className="cg-wrap learn-mini-board" style={{ width: size, height: size }} aria-hidden="true">
      {lastMove
        ? lastMove.map((sq) => {
            const { x, y } = squareXY(sq, orientation)
            return <span key={sq} className="learn-mini-last" style={{ left: `${x * 12.5}%`, top: `${y * 12.5}%` }} />
          })
        : null}
      <div className="learn-mini-pieces" ref={piecesRef} />
    </div>
  )
}
