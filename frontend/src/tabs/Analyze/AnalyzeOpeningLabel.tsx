import type { JSX } from 'react'
import { Icon } from '../../components/Icon'
import { formatSanPath } from '../../lib/chess'
import { linesThrough } from '../../lib/tree'
import { t, tn } from '../../lib/i18n'
import type { AnalyzeOpeningMatch, AnalyzeOpeningsState } from './useAnalyzeOpenings'

export interface AnalyzeOpeningLabelProps {
  state: AnalyzeOpeningsState
  /** SAN path from the initial position (null when the board started from a custom position). */
  sans: readonly string[] | null
  onOpenLearn: (openingId: string, nodeId: string) => void
}

const NAG_CLASS: Record<string, string> = { '!': 'good', '!!': 'good', '!?': 'good', '?': 'bad', '??': 'bad', '?!': '' }
const MAX_LINE_NAMES = 2

function moveLabel(m: AnalyzeOpeningMatch): JSX.Element {
  const nag = m.node.nag
  return (
    <span className="analyze-opening-move">
      {formatSanPath([m.node.san], m.node.ply - 1)}
      {nag ? <span className={`nag ${NAG_CLASS[nag] ?? ''}`}>{nag}</span> : null}
    </span>
  )
}

/** The "Opening" card: which of our openings the current move sequence is in, and why the move is played. */
export function AnalyzeOpeningLabel({ state, sans, onOpenLearn }: AnalyzeOpeningLabelProps): JSX.Element {
  const head = (extra?: JSX.Element) => (
    <div className="analyze-opening-head">
      <Icon name="book" size={16} />
      <span className="analyze-opening-kicker">{t('Opening')}</span>
      {extra}
    </div>
  )

  let body: JSX.Element
  let status = 'none'
  if (sans === null) {
    body = <p className="analyze-opening-note muted">{t('Custom start position: the opening book is only checked for games from the initial position.')}</p>
    status = 'custom'
  } else if (sans.length === 0) {
    body = (
      <p className="analyze-opening-note muted">
        {tn(
          state.count,
          'Starting position. Make a move to look it up in your {n} opening.',
          'Starting position. Make a move to look it up in your {n} openings.',
        )}
      </p>
    )
    status = 'start'
  } else if (state.error && state.exact.length === 0 && !state.partial) {
    body = <p className="analyze-opening-note muted">{t('Opening book unavailable: {error}', { error: state.error })}</p>
    status = 'error'
  } else if (state.loading) {
    body = <p className="analyze-opening-note muted">{t('Checking your opening book…')}</p>
    status = 'loading'
  } else if (state.exact.length > 0) {
    const best = state.exact[0]
    const others = state.exact.slice(1)
    const lines = linesThrough(best.node, best.opening.lines)
    status = 'book'
    return (
      <div className="analyze-opening book" data-testid="analyze-opening" data-status={status} data-opening={best.opening.id}>
        {head(
          <button
            type="button"
            className="btn btn-ghost btn-sm analyze-opening-learn"
            title={t('Open this position in the Learn tab')}
            onClick={() => onOpenLearn(best.opening.id, best.node.id)}
          >
            <Icon name="learn" size={14} /> {t('Learn')}
          </button>,
        )}
        <div className="analyze-opening-name">
          <span className="analyze-opening-title" data-testid="analyze-opening-name">
            {best.opening.name}
          </span>
          {best.opening.eco ? <span className="badge badge-eco">{best.opening.eco}</span> : null}
          <span className={`badge badge-${best.opening.side}`} title={t('The side this repertoire is played for')}>
            {best.opening.side}
          </span>
        </div>
        <div className="analyze-opening-why" data-testid="analyze-opening-why">
          {moveLabel(best)}
          <span>{best.node.why || t('Book move (no explanation in the data).')}</span>
        </div>
        {lines.length > 0 ? (
          <div className="analyze-opening-lines dim" title={lines.map((l) => l.name).join('\n')}>
            {tn(lines.length, 'Line: ', '{n} lines: ')}
            {lines
              .slice(0, MAX_LINE_NAMES)
              .map((l) => l.name)
              .join(' · ')}
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="analyze-opening-also dim" title={others.map((o) => o.opening.name).join('\n')}>
            {t('Also in: {names}', { names: others.map((o) => o.opening.name).join(', ') })}
          </div>
        ) : null}
      </div>
    )
  } else if (state.partial) {
    const p = state.partial
    status = 'left'
    body = (
      <p className="analyze-opening-note">
        <span className="bold">{t('Out of book.')}</span>{' '}
        <span className="muted">
          {t('Left')} <button type="button" className="analyze-link" onClick={() => onOpenLearn(p.opening.id, p.node.id)}>{p.opening.name}</button> {t('after')}{' '}
          {moveLabel(p)}.
        </span>
      </p>
    )
  } else {
    body = <p className="analyze-opening-note muted">{t('Not in your openings.')}</p>
  }

  return (
    <div className="analyze-opening" data-testid="analyze-opening" data-status={status}>
      {head()}
      {body}
    </div>
  )
}
