import type { JSX } from 'react'
import type { Side } from '../../api/types'
import type { PieceSymbol } from '../../lib/chess'
import type { Pocket, PocketRole } from '../../lib/variants'
import { PlayPieceIcon } from './PlayPlayerBar'

const ROLES: readonly { role: PocketRole; piece: PieceSymbol }[] = [
  { role: 'pawn', piece: 'p' },
  { role: 'knight', piece: 'n' },
  { role: 'bishop', piece: 'b' },
  { role: 'rook', piece: 'r' },
  { role: 'queen', piece: 'q' },
]

export interface PlayPocketProps {
  color: Side
  pocket: Pocket
  /** The pieces can be picked up (the student's own pocket, on the student's turn). */
  active: boolean
  armed: PocketRole | null
  /** `event` is the mousedown when the piece may also be dragged; a keyboard press has none. */
  onPick: (role: PocketRole, event?: MouseEvent) => void
}

/** Crazyhouse: the captured pieces a player can drop. Drag one to a square, or click it and then the square. */
export function PlayPocket({ color, pocket, active, armed, onPick }: PlayPocketProps): JSX.Element {
  return (
    <div className="play-pocket" data-testid={`play-pocket-${color}`}>
      {ROLES.filter(({ role }) => pocket[role] > 0).map(({ role, piece }) => (
        <button
          key={role}
          type="button"
          className={`play-pocket-piece${armed === role ? ' armed' : ''}`}
          disabled={!active}
          title={active ? `Drop a ${role}` : undefined}
          aria-pressed={armed === role}
          data-role={role}
          data-count={pocket[role]}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            onPick(role, e.nativeEvent)
          }}
          onClick={(e) => {
            if (e.detail === 0) onPick(role) // Enter or Space
          }}
        >
          <PlayPieceIcon piece={piece} color={color} />
          {pocket[role] > 1 ? <span className="play-pocket-count">{pocket[role]}</span> : null}
        </button>
      ))}
    </div>
  )
}
