/**
 * LearnIdeasPanel: summary, ECO / family, key ideas, typical plans, common mistakes and sources.
 */
import type { JSX } from 'react'
import type { LineMeta, OpeningFull } from '../../api/types'
import { Icon } from '../../components/Icon'
import { LearnDeclinedBox } from './LearnLinesPanel'
import { learnIsGambit, learnSourceLabel } from './learnUtils'

export interface LearnIdeasPanelProps {
  opening: OpeningFull
  activeLineId: string | null
  onSelectLine: (line: LineMeta) => void
}

function Bullets({ title, items, kind }: { title: string; items: readonly string[]; kind: 'ideas' | 'plans' | 'mistakes' }): JSX.Element | null {
  if (!items.length) return null
  return (
    <section className={`learn-ideas-section learn-ideas-${kind}`}>
      <h4>{title}</h4>
      <ul className="learn-ideas-list">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </section>
  )
}

export function LearnIdeasPanel({ opening, activeLineId, onSelectLine }: LearnIdeasPanelProps): JSX.Element {
  return (
    <div className="learn-ideas">
      <section className="learn-ideas-section">
        <div className="row wrap gap-4 learn-ideas-badges">
          <span className={`badge badge-${opening.side}`}>You play {opening.side === 'white' ? 'White' : 'Black'}</span>
          {opening.eco ? <span className="badge badge-eco">ECO {opening.eco}</span> : null}
          <span className="badge">{opening.lineCount} lines</span>
        </div>
        {opening.family ? <p className="learn-ideas-family">{opening.family}</p> : null}
        <p className="learn-ideas-summary">{opening.summary}</p>
      </section>
      {learnIsGambit(opening.name) ? <LearnDeclinedBox lines={opening.lines} activeLineId={activeLineId} onSelectLine={onSelectLine} /> : null}
      <Bullets title="Key ideas" items={opening.keyIdeas} kind="ideas" />
      <Bullets title="Typical plans" items={opening.typicalPlans} kind="plans" />
      <Bullets title="Common mistakes" items={opening.commonMistakes} kind="mistakes" />
      {opening.sources.length ? (
        <section className="learn-ideas-section">
          <h4>Sources</h4>
          <ul className="learn-sources">
            {opening.sources.map((s, i) => {
              const { href, label } = learnSourceLabel(s)
              return (
                <li key={i}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
                      <Icon name="external" size={13} /> <span className="truncate">{label}</span>
                    </a>
                  ) : (
                    <span className="muted">{label}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
