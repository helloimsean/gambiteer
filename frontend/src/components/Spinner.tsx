import type { JSX } from 'react'
import { t } from '../lib/i18n'
import './controls.css'

export interface SpinnerProps {
  /** Pixel size. Default 18. */
  size?: number
  className?: string
}

export function Spinner({ size = 18, className }: SpinnerProps): JSX.Element {
  return (
    <span
      className={`ui-spinner${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label={t('Loading')}
    />
  )
}
