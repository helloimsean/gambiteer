import { useEffect, useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import './Modal.css'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Buttons for the footer row. */
  footer?: ReactNode
  /** CSS width, default 520px. */
  width?: number | string
  /** When false the modal can only be closed through its buttons (no Esc / backdrop). Default true. */
  dismissible?: boolean
  className?: string
}

/** Centered dialog rendered in a portal. Esc and backdrop click call `onClose` when `dismissible`. */
export function Modal({ open, onClose, title, children, footer, width, dismissible = true, className }: ModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismissible])

  // only when it opens: callers re-render with new props while the user is working inside the dialog
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="ui-modal-backdrop"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`ui-modal${className ? ` ${className}` : ''}`}
        style={width !== undefined ? { maxWidth: width } : undefined}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {title !== undefined || dismissible ? (
          <div className="ui-modal-header">
            <h2>{title}</h2>
            {dismissible ? (
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
                <Icon name="close" size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="ui-modal-body">{children}</div>
        {footer ? <div className="ui-modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
