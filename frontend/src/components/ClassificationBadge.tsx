import type { CSSProperties, JSX } from 'react'
import type { Classification } from '../api/types'
import './ClassificationBadge.css'

/** chess.com palette (see ARCHITECTURE.md). Also exposed as CSS variables `--cls-<name>`. */
export const CLASSIFICATION_COLORS: Record<Classification, string> = {
  brilliant: '#1baca6',
  great: '#5c8bb0',
  best: '#95bb4a',
  excellent: '#96bc4b',
  good: '#96af8b',
  book: '#a88865',
  inaccuracy: '#f7c631',
  mistake: '#ffa459',
  blunder: '#fa412d',
  miss: '#ff7769',
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  brilliant: 'Brilliant',
  great: 'Great',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
  miss: 'Miss',
}

/** Glyph shown inside the circle; empty for icon-based ones. */
export const CLASSIFICATION_GLYPHS: Record<Classification, string> = {
  brilliant: '!!',
  great: '!',
  best: '',
  excellent: '',
  good: '',
  book: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  miss: 'X',
}

/** Classifications worth explaining / highlighting in a review ("key moments"). */
export const KEY_MOMENT_CLASSIFICATIONS: readonly Classification[] = ['brilliant', 'great', 'inaccuracy', 'mistake', 'blunder', 'miss']

export interface ClassificationBadgeProps {
  classification: Classification
  /** Pixel diameter of the icon. Default 20. */
  size?: number
  /** Render the text label next to the icon. */
  withLabel?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}

function glyphIcon(size: number, color: string, glyph: string, title: string): JSX.Element {
  const fontSize = glyph.length > 1 ? 12.5 : 15
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={title} role="img">
      <title>{title}</title>
      <circle cx="12" cy="12" r="11" fill={color} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight="800"
        fontFamily="Segoe UI, system-ui, sans-serif"
        letterSpacing={glyph.length > 1 ? -0.8 : 0}
        fill="#fff"
      >
        {glyph}
      </text>
    </svg>
  )
}

function starIcon(size: number, color: string, title: string): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={title} role="img">
      <title>{title}</title>
      <circle cx="12" cy="12" r="11" fill={color} />
      <path d="m12 5 2.1 4.4 4.8.6-3.5 3.3.9 4.8L12 15.8l-4.3 2.3.9-4.8L5.1 10l4.8-.6z" fill="#fff" />
    </svg>
  )
}

function checkIcon(size: number, color: string, title: string, double: boolean): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={title} role="img">
      <title>{title}</title>
      <circle cx="12" cy="12" r="11" fill={color} />
      {double ? (
        <>
          <path d="m5.5 12.5 3.2 3.2L15 9.4" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m12.5 15.3 6.2-6.2" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        </>
      ) : (
        <path d="m6.5 12.5 3.6 3.6L17.8 8.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

function bookIcon(size: number, color: string, title: string): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={title} role="img">
      <title>{title}</title>
      <circle cx="12" cy="12" r="11" fill={color} />
      <path
        d="M6.5 7.2c1.8-.6 3.6-.4 5.5.8 1.9-1.2 3.7-1.4 5.5-.8v9.3c-1.8-.6-3.6-.4-5.5.8-1.9-1.2-3.7-1.4-5.5-.8z"
        fill="#fff"
      />
      <path d="M12 8v9.3" stroke={color} strokeWidth="1.2" />
    </svg>
  )
}

/** Inline SVG icon for a move classification, optionally with its label. */
export function ClassificationBadge({ classification, size = 20, withLabel, className, style, title }: ClassificationBadgeProps): JSX.Element {
  const color = CLASSIFICATION_COLORS[classification]
  const label = CLASSIFICATION_LABELS[classification]
  const t = title ?? label
  let icon: JSX.Element
  switch (classification) {
    case 'best':
      icon = starIcon(size, color, t)
      break
    case 'excellent':
      icon = checkIcon(size, color, t, true)
      break
    case 'good':
      icon = checkIcon(size, color, t, false)
      break
    case 'book':
      icon = bookIcon(size, color, t)
      break
    default:
      icon = glyphIcon(size, color, CLASSIFICATION_GLYPHS[classification], t)
  }
  return (
    <span className={`cls-badge${className ? ` ${className}` : ''}`} style={style}>
      {icon}
      {withLabel ? (
        <span className="cls-label" style={{ color }}>
          {label}
        </span>
      ) : null}
    </span>
  )
}
