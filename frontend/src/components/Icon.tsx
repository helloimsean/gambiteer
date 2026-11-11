import type { CSSProperties, JSX } from 'react'

/** Names of the inline SVG icons. All icons are 24x24 stroke-based and inherit `currentColor`. */
export type IconName =
  | 'learn'
  | 'quiz'
  | 'analyze'
  | 'play'
  | 'review'
  | 'flip'
  | 'first'
  | 'prev'
  | 'next'
  | 'last'
  | 'copy'
  | 'settings'
  | 'sound'
  | 'soundOff'
  | 'close'
  | 'check'
  | 'plus'
  | 'trash'
  | 'refresh'
  | 'info'
  | 'warning'
  | 'external'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronRight'
  | 'history'
  | 'download'
  | 'hint'
  | 'undo'
  | 'flag'
  | 'autoplay'
  | 'pause'
  | 'knight'
  | 'engine'
  | 'brain'
  | 'fish'
  | 'book'
  | 'target'
  | 'search'
  | 'robot'
  | 'chart'
  | 'edit'
  | 'upload'
  | 'star'
  | 'swords'
  | 'people'

const PATHS: Record<IconName, JSX.Element> = {
  // navigation
  learn: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5V5.5M20 18v3H6.5" />
      <path d="M8 7h8M8 10.5h6" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5V5.5M20 18v3H6.5" />
    </>
  ),
  quiz: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  analyze: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
      <path d="M8 10.5h5M10.5 8v5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  play: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="14" r="1.3" fill="currentColor" />
      <circle cx="15" cy="14" r="1.3" fill="currentColor" />
      <path d="M9.5 17.5h5" />
    </>
  ),
  robot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="14" r="1.3" fill="currentColor" />
      <circle cx="15" cy="14" r="1.3" fill="currentColor" />
    </>
  ),
  review: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="m7 15 4-5 3 3 5-7" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16v-5M12 16V7M17 16v-3" />
    </>
  ),
  // board controls
  flip: (
    <>
      <path d="M4 9a8 8 0 0 1 14-3l2 2" />
      <path d="M20 3v5h-5" />
      <path d="M20 15a8 8 0 0 1-14 3l-2-2" />
      <path d="M4 21v-5h5" />
    </>
  ),
  first: (
    <>
      <path d="M6 5v14" />
      <path d="m18 6-8 6 8 6z" fill="currentColor" />
    </>
  ),
  prev: <path d="m15 5-7 7 7 7" />,
  next: <path d="m9 5 7 7-7 7" />,
  last: (
    <>
      <path d="M18 5v14" />
      <path d="m6 6 8 6-8 6z" fill="currentColor" />
    </>
  ),
  autoplay: <path d="m7 5 12 7-12 7z" fill="currentColor" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" strokeWidth="3" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h12l-2 4 2 4H5" />
    </>
  ),
  hint: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z" />
    </>
  ),
  // generic
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  sound: (
    <>
      <path d="M4 10v4h3l4 4V6L7 10z" fill="currentColor" />
      <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  soundOff: (
    <>
      <path d="M4 10v4h3l4 4V6L7 10z" fill="currentColor" />
      <path d="m16 9 5 5M21 9l-5 5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 21h20z" />
      <path d="M12 10v5M12 17.5v.5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12M7 11l5 5 5-5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  knight: (
    <path d="M8 20h9c0-5-1.5-8.5-5-10.5.5-1.3.5-2.5-.3-3.5-.6-.7-1.2-.8-1.7-.5l-.5 1.5c-1.5.5-3 2-3.5 4 0 .5.3.8.8.8 1 0 1.7-.6 2.3-1.3.5 1.3.2 2.7-.8 3.8C7.2 15.4 7 17.5 7 19.5z" />
  ),
  engine: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  brain: (
    <>
      <path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v.6A3.5 3.5 0 0 0 4.5 13 3.5 3.5 0 0 0 6 19.4V20a2 2 0 0 0 4 0V5.5A2.5 2.5 0 0 0 9.5 3z" />
      <path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v.6a3.5 3.5 0 0 1 1.5 5.9A3.5 3.5 0 0 1 18 19.4V20a2 2 0 0 1-4 0V5.5A2.5 2.5 0 0 1 14.5 3z" />
    </>
  ),
  fish: (
    <>
      <path d="M2 12c3-5 9-7 14-3l5-3v12l-5-3c-5 4-11 2-14-3z" />
      <path d="M7.5 10.5v.01" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4l11-11-4-4L4 16z" />
      <path d="m13 7 4 4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  star: <path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.5-3.6 3.1-6 6.5-6s6 2.4 6.5 6" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5c2 .8 3.2 2.8 3.5 5.5" />
    </>
  ),
  swords: (
    <>
      <path d="m4 4 12 12M20 4 8 16" />
      <path d="M14 18l2-2 3 3-2 2zM10 18l-2-2-3 3 2 2z" />
    </>
  ),
}

export interface IconProps {
  name: IconName
  /** Pixel size (width = height). Default 20. */
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
  strokeWidth?: number
}

export function Icon({ name, size = 20, className, style, title, strokeWidth = 1.8 }: IconProps): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[]
