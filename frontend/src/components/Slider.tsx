import type { JSX } from 'react'
import './controls.css'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label?: string
  /** Format the displayed value (default: the number). */
  format?: (value: number) => string
  disabled?: boolean
  className?: string
}

/** Range input with a label and the formatted current value. */
export function Slider({ value, min, max, step = 1, onChange, label, format, disabled, className }: SliderProps): JSX.Element {
  return (
    <div className={`ui-slider${className ? ` ${className}` : ''}`}>
      {label || format ? (
        <div className="ui-slider-head">
          <span className="ui-label">{label}</span>
          <span className="ui-value">{format ? format(value) : value}</span>
        </div>
      ) : null}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
