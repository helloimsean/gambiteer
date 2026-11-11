import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import type { Side } from '../../api/types'
import { Icon, type IconName } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import type { PieceSymbol } from '../../lib/chess'
import { t } from '../../lib/i18n'

const ROLES: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

/**
 * One chessground (cburnett) piece sprite. The sprites are keyed on the literal `<piece>` tag,
 * which React would warn about, so the element is created imperatively (same trick as the Board's
 * promotion chooser).
 */
export function PlayPieceIcon({ piece, color }: { piece: PieceSymbol; color: Side }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const el = document.createElement('piece')
    el.className = `${ROLES[piece]} ${color}`
    host.appendChild(el)
    return () => el.remove()
  }, [piece, color])
  return <span ref={ref} className="play-piece cg-wrap" />
}

export interface PlayPlayerBarProps {
  name: string
  /** Small text after the name (Elo, "you"). */
  detail?: string
  icon: IconName
  /** The colour this player has. */
  color: Side
  /** Opponent pieces this player has captured, sorted by value (from `materialInfo`). */
  captured: readonly PieceSymbol[]
  /** Material advantage of this player in pawns (shown when > 0). */
  advantage: number
  /** It is this player's turn (live game only). */
  toMove: boolean
  thinking?: boolean
  testId?: string
  /** Crazyhouse: shown instead of the captured pieces. */
  pocket?: ReactNode
}

/** Name plate above/below the board with captured pieces and the material difference. */
export function PlayPlayerBar({ name, detail, icon, color, captured, advantage, toMove, thinking, testId, pocket }: PlayPlayerBarProps): JSX.Element {
  const capturedColor: Side = color === 'white' ? 'black' : 'white'
  // group equal pieces so they overlap like on chess.com
  const groups: { piece: PieceSymbol; count: number }[] = []
  for (const p of captured) {
    const last = groups[groups.length - 1]
    if (last && last.piece === p) last.count += 1
    else groups.push({ piece: p, count: 1 })
  }
  return (
    <div className={`play-bar${toMove ? ' to-move' : ''}`} data-testid={testId}>
      <div className={`play-avatar ${color}`}>
        <Icon name={icon} size={20} />
      </div>
      <div className="play-bar-text">
        <div className="play-bar-name">
          <span className="truncate">{name}</span>
          {detail ? <span className="play-bar-detail">{detail}</span> : null}
          {thinking ? (
            <span className="play-bar-thinking" title={t('Thinking')}>
              <Spinner size={13} />
            </span>
          ) : null}
        </div>
        {pocket ?? (
          <div className="play-captured" aria-label={t('Captured: {pieces}', { pieces: captured.join(' ') || t('nothing') })}>
            {groups.map((g) => (
              <span key={g.piece} className="play-captured-group" data-piece={g.piece} data-count={g.count}>
                {Array.from({ length: g.count }, (_, i) => (
                  <PlayPieceIcon key={i} piece={g.piece} color={capturedColor} />
                ))}
              </span>
            ))}
            {advantage > 0 ? <span className="play-advantage">+{advantage}</span> : null}
          </div>
        )}
      </div>
      <span className={`play-turn-dot${toMove ? ' on' : ''}`} title={toMove ? t('To move') : undefined} />
    </div>
  )
}
