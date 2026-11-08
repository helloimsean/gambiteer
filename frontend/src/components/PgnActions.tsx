import { useEffect, useRef, useState, type JSX } from 'react'
import { copyText, downloadPgn } from '../lib/pgnTransfer'
import { Icon } from './Icon'

export interface PgnActionsProps {
  /** Built on demand, so the PGN is always the current one. */
  getPgn: () => string
  fileName: string
}

/** Copy PGN and Download PGN buttons, with a short confirmation after copying. */
export function PgnActions({ getPgn, fileName }: PgnActionsProps): JSX.Element {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    setCopied((await copyText(getPgn())) ? 'ok' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1800)
  }

  return (
    <div className="row wrap">
      <button type="button" className="btn btn-sm" onClick={() => void copy()} data-testid="pgn-copy">
        <Icon name="copy" size={15} /> Copy PGN
      </button>
      <button type="button" className="btn btn-sm" onClick={() => downloadPgn(getPgn(), fileName)} data-testid="pgn-download">
        <Icon name="download" size={15} /> Download PGN
      </button>
      {copied ? (
        <span className="small bold" role="status" data-testid="pgn-copied">
          {copied === 'ok' ? 'PGN copied' : 'Copy failed'}
        </span>
      ) : null}
    </div>
  )
}
