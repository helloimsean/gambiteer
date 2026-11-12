import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { t } from '../lib/i18n'
import { Icon, type IconName } from './Icon'
import './controls.css'

export interface ToolbarProps {
  children: ReactNode
  /** Horizontal distribution of the items. Default "center". */
  align?: 'start' | 'center' | 'end' | 'between'
  className?: string
}

/** A row of board controls (under the board or in a panel footer). */
export function Toolbar({ children, align = 'center', className }: ToolbarProps): JSX.Element {
  return (
    <div className={`ui-toolbar align-${align}${className ? ` ${className}` : ''}`} role="toolbar">
      {children}
    </div>
  )
}

export interface ToolbarButtonProps {
  icon: IconName
  /** Tooltip and accessible name. */
  title: string
  onClick: () => void
  /** Optional visible text next to the icon. */
  label?: string
  disabled?: boolean
  /** Pressed / toggled-on look. */
  active?: boolean
  /** Green primary style. */
  primary?: boolean
  className?: string
}

/** Icon button for a Toolbar. */
export function ToolbarButton({ icon, title, onClick, label, disabled, active, primary, className }: ToolbarButtonProps): JSX.Element {
  const cls = ['btn', primary ? 'btn-primary' : '', label ? '' : 'btn-icon', active ? 'active' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={18} />
      {label ? <span>{label}</span> : null}
    </button>
  )
}

export interface MoveNavProps {
  /** Current ply (0 = start position). */
  ply: number
  /** Last reachable ply (usually the number of moves). */
  maxPly: number
  onChange: (ply: number) => void
  /** First reachable ply. Default 0. */
  minPly?: number
  /**
   * Bind Left/Right/Home/End (and Up/Down for first/last) on the window while mounted. Default
   * false. Keys are ignored while the focus is in an input, select or textarea, or when a modal
   * dialog is open.
   */
  keyboard?: boolean
  /** Extra buttons rendered after the four navigation buttons (e.g. a flip button). */
  children?: ReactNode
  className?: string
}

function typingInField(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

/** First / previous / next / last buttons with optional arrow-key navigation. */
export function MoveNav({ ply, maxPly, onChange, minPly = 0, keyboard = false, children, className }: MoveNavProps): JSX.Element {
  const stateRef = useRef({ ply, maxPly, minPly, onChange })
  useEffect(() => {
    stateRef.current = { ply, maxPly, minPly, onChange }
  })

  useEffect(() => {
    if (!keyboard) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingInField()) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const s = stateRef.current
      let next: number | null = null
      if (e.key === 'ArrowLeft') next = Math.max(s.minPly, s.ply - 1)
      else if (e.key === 'ArrowRight') next = Math.min(s.maxPly, s.ply + 1)
      else if (e.key === 'Home' || e.key === 'ArrowUp') next = s.minPly
      else if (e.key === 'End' || e.key === 'ArrowDown') next = s.maxPly
      if (next === null) return
      e.preventDefault()
      if (next !== s.ply) s.onChange(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard])

  const atStart = ply <= minPly
  const atEnd = ply >= maxPly
  return (
    <Toolbar className={className}>
      <ToolbarButton icon="first" title={t('First move (Home)')} onClick={() => onChange(minPly)} disabled={atStart} />
      <ToolbarButton icon="prev" title={t('Previous move (Left arrow)')} onClick={() => onChange(Math.max(minPly, ply - 1))} disabled={atStart} />
      <ToolbarButton icon="next" title={t('Next move (Right arrow)')} onClick={() => onChange(Math.min(maxPly, ply + 1))} disabled={atEnd} />
      <ToolbarButton icon="last" title={t('Last move (End)')} onClick={() => onChange(maxPly)} disabled={atEnd} />
      {children}
    </Toolbar>
  )
}
