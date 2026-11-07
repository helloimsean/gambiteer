import type { JSX } from 'react'
import './controls.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string> {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  label?: string
  /** Label beside the control instead of above it. */
  inline?: boolean
  disabled?: boolean
  className?: string
  title?: string
}

/** Native `<select>` styled for the theme. Generic over the option value type. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  inline,
  disabled,
  className,
  title,
}: SelectProps<T>): JSX.Element {
  return (
    <label className={`ui-select${inline ? ' inline' : ''}${className ? ` ${className}` : ''}`} title={title}>
      {label ? <span className="ui-label">{label}</span> : null}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
