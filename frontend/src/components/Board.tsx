/**
 * Board: React wrapper around chessground 9 (the lichess board).
 *
 * Contract (see src/tabs/README.md for the long version):
 * - Controlled: the board always shows the `fen` prop. A user move calls `onMove(from, to, promo?)`;
 *   accept it by passing the new fen, reject it by leaving `fen` unchanged (the piece snaps back on
 *   the next animation frame).
 * - One chessground instance per mounted Board, created in an effect and destroyed on unmount.
 *   Prop changes go through `api.set(...)`, so rapid `fen` changes just animate; the instance is
 *   only rebuilt when `coordinates` changes (chessground renders coordinates once).
 * - `fen` is only handed to chessground when it actually changed (or to undo a rejected move), so
 *   arrows the user drew with right-click survive unrelated prop updates such as engine arrows.
 * - Legal destinations come from chess.js unless `dests` is given; `rules` supplies everything
 *   chess.js would have worked out for a variant position it cannot read. Promotions open an overlay
 *   chooser (right-click anywhere = queen, Esc = cancel). Castling also works by dropping the king
 *   on its own rook; `onMove` always receives the normal form (e1g1).
 * - Never uses chessground's `viewOnly` (switching it after creation breaks drag handling);
 *   `interactive={false}` disables moving/selecting instead and keeps right-click arrows.
 * - Fills its container's width as a square (CSS `aspect-ratio`); chessground's own
 *   ResizeObserver keeps the pieces aligned when the container resizes.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type Ref,
} from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Config } from 'chessground/config'
import type { DrawShape } from 'chessground/draw'
import type { Key, Role } from 'chessground/types'
import { Chess } from 'chess.js'
import type { Side } from '../api/types'
import {
  destsFromFen,
  isPromotion,
  normalizeCastlingMove,
  turnFromFen,
  type Dests,
  type PromotionPiece,
  type Square,
} from '../lib/chess'
import { t } from '../lib/i18n'
import { playMoveSound, playSound } from '../lib/sounds'
import type { BoardRules, PocketRole } from '../lib/variants'
import './Board.css'

/** chessground's built-in brushes. */
export type BoardBrush =
  | 'green'
  | 'red'
  | 'blue'
  | 'yellow'
  | 'paleGreen'
  | 'paleRed'
  | 'paleBlue'
  | 'paleGrey'
  | 'purple'
  | 'pink'
  | 'white'

/** An arrow (`orig` -> `dest`) or, without `dest`, a circle on `orig`. */
export interface BoardShape {
  orig: Square
  dest?: Square
  /** Default "green". */
  brush?: BoardBrush
  /** Optional short text drawn on the arrow / circle (e.g. "1", "!"). */
  label?: string
  /** Line width override (chessground default 10, pale brushes 15). */
  lineWidth?: number
}

export type MovableColor = Side | 'both' | 'none'

/** What the Crazyhouse pocket needs from the board. */
export interface BoardHandle {
  /** Start dragging a pocket piece; call it from the mousedown that picked the piece up. */
  dragNewPiece: (role: PocketRole, color: Side, event: MouseEvent | TouchEvent) => void
}

/** Last move as UCI ("e2e4", "e7e8q") or a [from, to] pair. */
export type LastMove = string | readonly [Square, Square] | null | undefined

export interface BoardProps {
  /** Position to show (required; the board follows this prop). */
  fen: string
  /** Side at the bottom. Default "white". */
  orientation?: Side
  /** Highlighted last move. */
  lastMove?: LastMove
  /** Highlight the king in check. Computed from `fen` when omitted; pass `false` to suppress. */
  check?: boolean
  /** When false the pieces cannot be moved or selected (arrows can still be drawn). Default true. */
  interactive?: boolean
  /**
   * Who may move. Default "both" (= whoever is to move in `fen`). "white"/"black" restrict moving to
   * that colour and only on its turn; "none" is the same as `interactive={false}`.
   */
  movableColor?: MovableColor
  /** Legal destinations; computed from `fen` with chess.js when omitted. */
  dests?: Dests
  /** For a variant position chess.js cannot read. */
  rules?: BoardRules
  /** Called once the user completes a move (after choosing a promotion piece if needed). */
  onMove?: (from: Square, to: Square, promotion?: PromotionPiece) => void
  /** Crazyhouse: the piece a click on a square will drop. */
  dropPiece?: { role: PocketRole; color: Side } | null
  /** Crazyhouse: the user dropped a piece (the parent decides whether it was legal). */
  onDrop?: (role: PocketRole, square: Square) => void
  handleRef?: Ref<BoardHandle>
  /** Arrows and circles drawn on top of the board (replaces the previous set). */
  shapes?: readonly BoardShape[]
  /** Show file/rank coordinates. Default true. */
  coordinates?: boolean
  /** `false` disables animation; a number sets the duration in ms. Default 200. */
  animation?: boolean | number
  /** Play move/capture/check sounds when `fen` changes. Default true (still obeys the global mute). */
  sound?: boolean
  /** Change this number (e.g. increment it) to shake the board, for a wrong quiz answer. */
  shake?: number
  className?: string
  style?: CSSProperties
}

interface PendingPromotion {
  from: Square
  to: Square
  color: Side
  /** position it was started in; a different `fen` prop voids it */
  fen: string
}

const FILES = 'abcdefgh'
const PROMO_PIECES: { piece: PromotionPiece; role: string }[] = [
  { piece: 'q', role: 'queen' },
  { piece: 'n', role: 'knight' },
  { piece: 'r', role: 'rook' },
  { piece: 'b', role: 'bishop' },
]
const KING_PROMOTION: { piece: PromotionPiece; role: string } = { piece: 'k', role: 'king' }
/** Piece names for the promotion buttons' tooltips, keyed by `role`. */
const PROMO_NAMES: Record<string, string> = {
  queen: t('queen'),
  knight: t('knight'),
  rook: t('rook'),
  bishop: t('bishop'),
  king: t('king'),
}
const DEFAULT_ANIMATION_MS = 200
/** Fen changes closer together than this play only one sound (e.g. jumping through a game). */
const SOUND_THROTTLE_MS = 70

function normalizeLastMove(lm: LastMove): Key[] | undefined {
  if (!lm) return undefined
  if (typeof lm === 'string') {
    if (lm.length < 4) return undefined
    return [lm.slice(0, 2) as Key, lm.slice(2, 4) as Key]
  }
  return [lm[0], lm[1]]
}

function fenInCheck(fen: string): boolean {
  try {
    return new Chess(fen).inCheck()
  } catch {
    return false
  }
}

function toDrawShapes(shapes: readonly BoardShape[] | undefined): DrawShape[] {
  if (!shapes) return []
  return shapes.map((s) => ({
    orig: s.orig,
    dest: s.dest,
    brush: s.brush ?? 'green',
    ...(s.label ? { label: { text: s.label } } : {}),
    ...(s.lineWidth ? { modifiers: { lineWidth: s.lineWidth } } : {}),
  }))
}

function shapesKey(shapes: readonly BoardShape[] | undefined): string {
  if (!shapes || shapes.length === 0) return ''
  return shapes.map((s) => `${s.orig}${s.dest ?? ''}:${s.brush ?? ''}:${s.label ?? ''}:${s.lineWidth ?? ''}`).join('|')
}

/** Everything except `fen` (that one is added only when needed, see `apply`). */
function buildConfig(p: BoardProps): Config {
  const interactive = (p.interactive ?? true) && (p.movableColor ?? 'both') !== 'none'
  const turn = turnFromFen(p.fen)
  const mc = p.movableColor ?? 'both'
  const color: Side | undefined = !interactive ? undefined : mc === 'both' ? turn : (mc as Side)
  const anim = p.animation ?? DEFAULT_ANIMATION_MS
  const duration = typeof anim === 'number' ? anim : DEFAULT_ANIMATION_MS
  return {
    orientation: p.orientation ?? 'white',
    turnColor: turn,
    check: p.check ?? p.rules?.check ?? fenInCheck(p.fen),
    lastMove: normalizeLastMove(p.lastMove),
    coordinates: p.coordinates ?? true,
    viewOnly: false,
    disableContextMenu: true,
    autoCastle: true,
    animation: { enabled: anim !== false && duration > 0, duration },
    highlight: { lastMove: true, check: true },
    movable: {
      free: false,
      color,
      dests: color ? (p.dests ?? p.rules?.dests ?? destsFromFen(p.fen, { rookCastle: true })) : new Map(),
      showDests: true,
      rookCastle: true,
    },
    premovable: { enabled: false },
    draggable: { enabled: interactive, showGhost: true, autoDistance: true, deleteOnDropOff: false },
    selectable: { enabled: interactive },
    drawable: { enabled: true, visible: true, eraseOnClick: true, autoShapes: toDrawShapes(p.shapes) },
  }
}

/** chessground has no config entry for this, and its setDropMode() would cancel a drag already under way. */
function syncDropMode(api: Api, piece: BoardProps['dropPiece']): void {
  api.state.dropmode = piece ? { active: true, piece } : { active: false }
}

/**
 * A chessground-styled piece for the promotion chooser. The cburnett sprites are keyed on the
 * literal `<piece>` tag, which React would warn about, so the element is created imperatively.
 */
function PromoPiece({ role, color }: { role: string; color: Side }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const piece = document.createElement('piece')
    piece.className = `${role} ${color}`
    host.appendChild(piece)
    return () => piece.remove()
  }, [role, color])
  return <span ref={ref} className="board-promo-piece" />
}

export function Board(props: BoardProps): JSX.Element {
  const {
    fen,
    orientation = 'white',
    lastMove,
    check,
    interactive = true,
    movableColor = 'both',
    dests,
    rules,
    dropPiece,
    handleRef,
    shapes,
    coordinates = true,
    animation = DEFAULT_ANIMATION_MS,
    sound = true,
    shake,
    className,
    style,
  } = props

  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<Api | null>(null)
  const propsRef = useRef<BoardProps>(props)
  /** fen the chessground pieces were last set from */
  const appliedFenRef = useRef<string | null>(null)
  /** a user move changed the pieces since `appliedFenRef` was set */
  const dirtyRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const [promo, setPromoState] = useState<PendingPromotion | null>(null)
  const promoRef = useRef<PendingPromotion | null>(null)
  const [shaking, setShaking] = useState(false)

  const setPromo = useCallback((value: PendingPromotion | null) => {
    promoRef.current = value
    setPromoState(value)
  }, [])

  // keep the latest props for callbacks fired by chessground (runs before any effect below)
  useLayoutEffect(() => {
    propsRef.current = props
  })

  /** Push the current props into chessground. The fen is included only when needed. */
  const apply = useCallback((forceFen = false) => {
    const api = apiRef.current
    if (!api) return
    const p = propsRef.current
    const config = buildConfig(p)
    if (forceFen || dirtyRef.current || appliedFenRef.current !== p.fen) {
      config.fen = p.fen
      appliedFenRef.current = p.fen
      dirtyRef.current = false
    }
    api.set(config)
    syncDropMode(api, p.dropPiece)
  }, [])

  /** After a user move: re-sync on the next frame (snaps back if the parent kept the old fen). */
  const scheduleResync = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      apply()
    })
  }, [apply])

  const handleUserMove = useCallback(
    (orig: Key, dest: Key) => {
      const p = propsRef.current
      dirtyRef.current = true
      const { from, to } = p.rules ? { from: orig as Square, to: dest as Square } : normalizeCastlingMove(p.fen, orig as Square, dest as Square)
      if (p.rules ? p.rules.isPromotion(from, to) : isPromotion(p.fen, from, to)) {
        setPromo({ from, to, color: turnFromFen(p.fen), fen: p.fen })
        return
      }
      p.onMove?.(from, to)
      scheduleResync()
    },
    [scheduleResync, setPromo],
  )

  const handleUserDrop = useCallback(
    (role: Role, key: Key) => {
      dirtyRef.current = true
      propsRef.current.onDrop?.(role as PocketRole, key as Square)
      scheduleResync()
    },
    [scheduleResync],
  )

  useImperativeHandle(
    handleRef,
    () => ({
      dragNewPiece: (role, color, event) => {
        const api = apiRef.current
        if (!api) return
        api.state.dom.bounds.clear()
        api.dragNewPiece({ role, color }, event)
      },
    }),
    [],
  )

  // create / destroy (rebuilt only when coordinates change: chessground renders them once)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const p = propsRef.current
    const config = buildConfig(p)
    config.fen = p.fen
    config.movable = { ...config.movable, events: { after: handleUserMove, afterNewPiece: handleUserDrop } }
    const api = Chessground(el, config)
    apiRef.current = api
    appliedFenRef.current = p.fen
    dirtyRef.current = false
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      api.destroy()
      if (apiRef.current === api) apiRef.current = null
      el.innerHTML = ''
      el.className = 'board-cg'
    }
  }, [coordinates, handleUserMove, handleUserDrop])

  // props -> board
  const lastMoveKey = normalizeLastMove(lastMove)?.join('') ?? ''
  const shapeKey = shapesKey(shapes)
  const animKey = String(animation)
  useEffect(() => {
    apply()
  }, [fen, orientation, lastMoveKey, check, interactive, movableColor, dests, rules, dropPiece, shapeKey, animKey, apply])

  // sounds on fen change (programmatic moves included)
  const prevFenRef = useRef(fen)
  const lastSoundRef = useRef(0)
  useEffect(() => {
    const prev = prevFenRef.current
    prevFenRef.current = fen
    if (prev === fen || !sound) return
    const now = performance.now()
    if (now - lastSoundRef.current < SOUND_THROTTLE_MS) return
    lastSoundRef.current = now
    const { rules, movableColor: mover, orientation: bottom = 'white' } = propsRef.current
    const player = mover === 'white' || mover === 'black' ? mover : bottom
    playMoveSound(prev, fen, rules?.check ?? fenInCheck(fen), player)
  }, [fen, sound])

  // shake: any change of the `shake` number after mount
  const prevShakeRef = useRef(shake)
  useEffect(() => {
    if (prevShakeRef.current === shake) return
    prevShakeRef.current = shake
    setShaking(false)
    const start = requestAnimationFrame(() => setShaking(true))
    const stop = setTimeout(() => setShaking(false), 450)
    return () => {
      cancelAnimationFrame(start)
      clearTimeout(stop)
    }
  }, [shake])

  // coordinate font size follows the board size
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) root.style.setProperty('--board-size', `${Math.round(w)}px`)
    })
    ro.observe(root)
    return () => ro.disconnect()
  }, [])

  const choosePromotion = useCallback(
    (piece: PromotionPiece) => {
      const cur = promoRef.current
      setPromo(null)
      if (!cur || cur.fen !== propsRef.current.fen) return
      const p = propsRef.current
      if (p.sound ?? true) {
        playSound('promote')
        lastSoundRef.current = performance.now() // the fen change right after stays quiet
      }
      p.onMove?.(cur.from, cur.to, piece)
      scheduleResync()
    },
    [scheduleResync, setPromo],
  )

  const cancelPromotion = useCallback(() => {
    setPromo(null)
    apply(true)
  }, [apply, setPromo])

  // a new position voids a pending promotion chooser (dropped during render so it cannot come back
  // if the fen later returns to the same value)
  const activePromo = promo && promo.fen === fen ? promo : null
  if (promo && !activePromo) setPromoState(null)

  // Esc cancels the promotion chooser
  useEffect(() => {
    if (!activePromo) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPromotion()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activePromo, cancelPromotion])

  // promotion chooser geometry
  let promoStyle: CSSProperties | undefined
  let promoAtTop = false
  if (activePromo) {
    const fileIdx = FILES.indexOf(activePromo.to[0])
    const col = orientation === 'white' ? fileIdx : 7 - fileIdx
    promoAtTop = (activePromo.color === 'white') === (orientation === 'white')
    promoStyle = { left: `${col * 12.5}%` }
  }

  const isStatic = !interactive || movableColor === 'none'
  const rootClass = ['board-root', shaking ? 'board-shake' : '', isStatic ? 'board-static' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={style}
      data-fen={fen}
      data-orientation={orientation}
      // chessground remembers where the board is and re-measures only on scroll and resize, so a
      // layout change that moves it (the phone layout after Start) would send every press to the wrong square
      onPointerDownCapture={() => apiRef.current?.state.dom.bounds.clear()}
    >
      <div ref={hostRef} className="board-cg" />
      {activePromo ? (
        <>
          <div
            className="board-promo-backdrop"
            onMouseDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              cancelPromotion()
            }}
            onContextMenu={(e) => {
              // right-click = queen (chess.com convention)
              e.preventDefault()
              choosePromotion('q')
            }}
          />
          <div
            className={`board-promo cg-wrap ${promoAtTop ? 'top' : 'bottom'}`}
            style={promoStyle}
            role="dialog"
            aria-label={t('Choose promotion piece')}
            onContextMenu={(e) => {
              e.preventDefault()
              choosePromotion('q')
            }}
          >
            {(rules?.kingPromotion ? [...PROMO_PIECES, KING_PROMOTION] : PROMO_PIECES).map(({ piece, role }) => (
              <button
                key={piece}
                type="button"
                title={t('Promote to {piece}', { piece: PROMO_NAMES[role] })}
                data-piece={piece}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choosePromotion(piece)}
              >
                <PromoPiece role={role} color={activePromo.color} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
