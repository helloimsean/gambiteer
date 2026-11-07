/**
 * Side-panel pieces of the Quiz tab: settings (mode, opening picker, line picker) and stats
 * (streak, session score, per-opening mastery, reset).
 */
import type { JSX } from 'react'
import type { OpeningSummary } from '../../api/types'
import { Icon } from '../../components/Icon'
import { masteryOf, type QuizSession, type QuizStats } from './QuizStats'
import { QUIZ_MODES, RANDOM_LINE, type LineOptionGroup, type QuizMode } from './QuizTasks'

// ---------------------------------------------------------------- settings

export interface QuizSettingsPanelProps {
  mode: QuizMode
  onModeChange: (mode: QuizMode) => void
  openings: OpeningSummary[]
  selected: string[]
  onToggleOpening: (id: string) => void
  onSelectAll: () => void
  lineChoice: string
  onLineChoice: (key: string) => void
  lineGroups: LineOptionGroup[]
  /** Item counts per opening for the current mode (positions / traps), when known. */
  itemCounts?: Record<string, number>
}

export function QuizSettingsPanel({
  mode,
  onModeChange,
  openings,
  selected,
  onToggleOpening,
  onSelectAll,
  lineChoice,
  onLineChoice,
  lineGroups,
  itemCounts,
}: QuizSettingsPanelProps): JSX.Element {
  const allSelected = openings.length > 0 && selected.length === openings.length
  const hint = QUIZ_MODES.find((m) => m.id === mode)?.hint ?? ''
  return (
    <div className="panel quiz-settings" data-testid="quiz-settings">
      <div className="panel-body quiz-settings-body">
        <div className="btn-group quiz-modes" role="tablist" aria-label="Quiz mode">
          {QUIZ_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={`btn btn-sm${mode === m.id ? ' active' : ''}`}
              onClick={() => onModeChange(m.id)}
              data-testid={`quiz-mode-${m.id}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="quiz-mode-hint dim small">{hint}</div>

        <div className="quiz-openings" aria-label="Openings">
          <button
            type="button"
            className={`quiz-chip${allSelected ? ' active' : ''}`}
            onClick={onSelectAll}
            aria-pressed={allSelected}
            data-testid="quiz-opening-all"
          >
            All
          </button>
          {openings.map((o) => {
            const on = selected.includes(o.id)
            const count = itemCounts?.[o.id]
            return (
              <button
                key={o.id}
                type="button"
                className={`quiz-chip${on ? ' active' : ''}`}
                aria-pressed={on}
                onClick={() => onToggleOpening(o.id)}
                title={`${o.name} (you play ${o.side})${count !== undefined ? `: ${count} ${mode === 'traps' ? 'trap positions' : 'positions'}` : ''}`}
                data-testid={`quiz-opening-${o.id}`}
              >
                <span className={`quiz-side-dot quiz-side-${o.side}`} />
                <span className="truncate">{o.name}</span>
                {count !== undefined && on ? <span className="quiz-chip-count">{count}</span> : null}
              </button>
            )
          })}
        </div>

        {mode === 'line' ? (
          <label className="field quiz-line-field">
            <span className="field-label">Line</span>
            <select value={lineChoice} onChange={(e) => onLineChoice(e.target.value)} data-testid="quiz-line-select">
              <option value={RANDOM_LINE}>Random line (weak lines more often)</option>
              {lineGroups.map((g) => (
                <optgroup key={g.openingId} label={g.openingName}>
                  {g.options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- stats

export interface QuizStatsPanelProps {
  session: QuizSession
  stats: QuizStats
  openings: OpeningSummary[]
  selected: string[]
  onReset: () => void
}

export function QuizStatsPanel({ session, stats, openings, selected, onReset }: QuizStatsPanelProps): JSX.Element {
  const pct = session.total ? Math.round((session.correct / session.total) * 100) : 0
  const shown = openings.filter((o) => selected.includes(o.id))
  return (
    <div className="panel quiz-stats" data-testid="quiz-stats">
      <div className="quiz-stats-top">
        <div className="quiz-stat" title="Correct first tries in a row">
          <div className={`quiz-stat-num${session.streak >= 5 ? ' hot' : ''}`} data-testid="quiz-streak">
            {session.streak}
          </div>
          <div className="quiz-stat-label">streak{session.best > 0 ? ` (best ${session.best})` : ''}</div>
        </div>
        <div className="quiz-stat" title="Moves right on the first try / moves asked, this session">
          <div className="quiz-stat-num" data-testid="quiz-score">
            {session.correct}/{session.total}
          </div>
          <div className="quiz-stat-label">session score{session.total ? ` (${pct}%)` : ''}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm quiz-reset" onClick={onReset} title="Reset quiz statistics" data-testid="quiz-reset">
          <Icon name="trash" size={15} /> Reset stats
        </button>
      </div>
      <div className="quiz-mastery" data-testid="quiz-mastery">
        {shown.map((o) => {
          const m = masteryOf(stats, o.id)
          return (
            <div
              key={o.id}
              className="quiz-mastery-row"
              title={`${m.mastered} of ${m.seen} positions seen are known (more right than wrong answers)`}
              data-testid={`quiz-mastery-${o.id}`}
              data-pct={m.pct}
              data-seen={m.seen}
            >
              <span className="quiz-mastery-name truncate">{o.name}</span>
              <div className="progress quiz-mastery-bar">
                <span style={{ width: `${m.pct}%` }} />
              </div>
              <span className="quiz-mastery-pct">{m.seen ? `${m.pct}%` : '-'}</span>
              <span className="quiz-mastery-count dim">
                {m.mastered}/{m.seen}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
