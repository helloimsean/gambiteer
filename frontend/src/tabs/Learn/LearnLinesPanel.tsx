/**
 * LearnLinesPanel: every line of the opening grouped by category (Main, Accepted, Declined,
 * Alternatives, Sidelines, Traps, Transpositions). The active line is expanded with its
 * description, evaluation and clickable moves. Gambits get a prominent "If declined" box on top.
 */
import { useEffect, useMemo, useRef, type JSX } from 'react'
import { LINE_CATEGORIES, LINE_CATEGORY_LABELS, type LineCategory, type LineMeta } from '../../api/types'
import { Icon } from '../../components/Icon'
import { scrollIntoViewWithin } from '../../lib/dom'
import { t, tn } from '../../lib/i18n'
import { learnIsGambit } from './learnUtils'

export interface LearnLinesPanelProps {
  openingName: string
  lines: readonly LineMeta[]
  activeLineId: string | null
  /** Current ply on the active line (to highlight the move in the expanded line). */
  ply: number
  onSelectLine: (line: LineMeta) => void
  /** Jump to a ply of a line (click on a move of the expanded line). */
  onJump: (line: LineMeta, ply: number) => void
  /** "Drill this line" (Quiz). */
  onDrill: (line: LineMeta) => void
}

/** "If declined": the declined lines of a gambit, shown prominently. */
export function LearnDeclinedBox({
  lines,
  activeLineId,
  onSelectLine,
}: {
  lines: readonly LineMeta[]
  activeLineId: string | null
  onSelectLine: (line: LineMeta) => void
}): JSX.Element {
  const declined = lines.filter((l) => l.category === 'declined')
  return (
    <section className="learn-declined" aria-label={t('If declined')}>
      <div className="learn-declined-title">
        <Icon name="warning" size={16} /> {t('If declined')}
      </div>
      {declined.length === 0 ? (
        <p className="learn-declined-empty">
          {t(
            'This repertoire has no lines marked as declined. If the opponent does not take the bait, look at the Alternatives and Sidelines groups below.',
          )}
        </p>
      ) : (
        <>
          <p className="learn-declined-intro">
            {t('Not every opponent takes the bait. Know what to play when the gambit is declined:')}
          </p>
          <ul className="learn-declined-list">
            {declined.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className={`learn-declined-item${l.id === activeLineId ? ' active' : ''}`}
                  onClick={() => onSelectLine(l)}
                  data-line-id={l.id}
                >
                  <span className="learn-declined-name">{l.name}</span>
                  {l.evaluation ? <span className="learn-declined-eval">{l.evaluation}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function LineMoves({ line, ply, onJump }: { line: LineMeta; ply: number; onJump: (line: LineMeta, ply: number) => void }): JSX.Element {
  return (
    <div className="learn-line-moves">
      {line.sans.map((san, i) => {
        const p = i + 1
        const white = p % 2 === 1
        return (
          <span key={p} className="learn-line-move-wrap">
            {white ? <span className="learn-tree-num">{Math.ceil(p / 2)}.</span> : null}
            <button
              type="button"
              className={`learn-line-move${p === ply ? ' current' : ''}${p > ply ? ' ahead' : ''}`}
              onClick={() => onJump(line, p)}
            >
              {san}
            </button>
          </span>
        )
      })}
    </div>
  )
}

export function LearnLinesPanel({ openingName, lines, activeLineId, ply, onSelectLine, onJump, onDrill }: LearnLinesPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => {
    const byCat = new Map<LineCategory, LineMeta[]>()
    for (const l of lines) {
      const arr = byCat.get(l.category) ?? []
      arr.push(l)
      byCat.set(l.category, arr)
    }
    const ordered: { category: LineCategory; lines: LineMeta[] }[] = []
    for (const c of LINE_CATEGORIES) {
      const arr = byCat.get(c)
      if (arr && arr.length) ordered.push({ category: c, lines: arr })
    }
    // unknown categories (not in the schema) last, so nothing is ever hidden
    for (const [c, arr] of byCat) if (!LINE_CATEGORIES.includes(c)) ordered.push({ category: c, lines: arr })
    return ordered
  }, [lines])

  useEffect(() => {
    if (!activeLineId) return
    const el = containerRef.current?.querySelector<HTMLElement>(`.learn-line[data-line-id="${CSS.escape(activeLineId)}"]`)
    const id = requestAnimationFrame(() => scrollIntoViewWithin(el ?? null, containerRef.current, 12))
    return () => cancelAnimationFrame(id)
  }, [activeLineId])

  return (
    <div className="learn-lines" ref={containerRef}>
      {learnIsGambit(openingName) ? <LearnDeclinedBox lines={lines} activeLineId={activeLineId} onSelectLine={onSelectLine} /> : null}
      {groups.map((g) => (
        <section key={g.category} className={`learn-line-group cat-${g.category}`} data-category={g.category}>
          <h4 className="learn-line-group-title">
            <span className={`learn-cat-dot cat-${g.category}`} />
            {(LINE_CATEGORY_LABELS[g.category] ?? g.category)}
            <span className="learn-line-group-count">{g.lines.length}</span>
          </h4>
          {g.lines.map((l) => {
            const active = l.id === activeLineId
            return (
              <div key={l.id} className={`learn-line${active ? ' active' : ''}`} data-line-id={l.id}>
                <button type="button" className="learn-line-head" onClick={() => onSelectLine(l)} aria-expanded={active}>
                  <span className="learn-line-name">{l.name}</span>
                  <span className="learn-line-plies">{tn(Math.ceil(l.sans.length / 2), '{n} move', '{n} moves')}</span>
                </button>
                {active ? (
                  <div className="learn-line-body fade-in">
                    {l.description ? <p className="learn-line-desc">{l.description}</p> : null}
                    {l.evaluation ? (
                      <p className="learn-line-eval">
                        <span className="learn-line-eval-label">{t('Evaluation')}</span> {l.evaluation}
                      </p>
                    ) : null}
                    <LineMoves line={l} ply={ply} onJump={onJump} />
                    <div className="row learn-line-actions">
                      <button type="button" className="btn btn-sm" onClick={() => onJump(l, 0)}>
                        <Icon name="first" size={14} /> {t('From the start')}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => onDrill(l)}>
                        <Icon name="quiz" size={14} /> {t('Drill this line')}
                      </button>
                    </div>
                  </div>
                ) : l.evaluation ? (
                  <div className="learn-line-sub truncate" title={l.evaluation}>
                    {l.evaluation}
                  </div>
                ) : null}
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
