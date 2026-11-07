import type { JSX } from 'react'
import './controls.css'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
  title?: string
}

/** On/off switch. */
export function Toggle({ checked, onChange, label, disabled, className, title }: ToggleProps): JSX.Element {
  return (
    <label className={`ui-toggle${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-toggle-track" />
      {label ? <span className="ui-toggle-label">{label}</span> : null}
    </label>
  )
}
