import { useMemo, type JSX } from 'react'
import { LINE_CATEGORIES, LINE_CATEGORY_LABELS, type OpeningFull, type OpeningSummary } from '../../api/types'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { Slider } from '../../components/Slider'
import { Spinner } from '../../components/Spinner'
import { Toggle } from '../../components/Toggle'
import { formatSanPath } from '../../lib/chess'
import {
  ELO_MAX,
  ELO_MIN,
  ELO_PRESETS,
  MOVETIME_OPTIONS,
  RANDOM_LINE,
  UCI_ELO_MIN,
  eloLevel,
  formatMovetime,
  strengthCaption,
  type ColorChoice,
  type OpeningMode,
  type PlaySetup,
} from './PlayGame'
import { PlayPieceIcon } from './PlayPlayerBar'

export interface PlaySetupFormProps {
  setup: PlaySetup
  onChange: (patch: Partial<PlaySetup>) => void
  /** Opening summaries (null while loading). */
  openings: OpeningSummary[] | null
  openingsError: string | null
  /** Full data of `setup.openingId` once loaded. */
  opening: OpeningFull | null
  openingError: string | null
  onRetry: () => void
}

const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'random', label: 'Random' },
  { value: 'black', label: 'Black' },
]

/** The new-game settings (used inline in the side panel and inside the New game dialog). */
export function PlaySetupForm({ setup, onChange, openings, openingsError, opening, openingError, onRetry }: PlaySetupFormProps): JSX.Element {
  const lineOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: RANDOM_LINE, label: 'Random line' }]
    if (!opening) return opts
    for (const cat of LINE_CATEGORIES) {
      for (const l of opening.lines) {
        if (l.category === cat) opts.push({ value: l.id, label: `${LINE_CATEGORY_LABELS[cat]}: ${l.name} (${l.sans.length} plies)` })
      }
    }
    return opts
  }, [opening])

  const selectedLine = opening && setup.lineId !== RANDOM_LINE ? opening.lines.find((l) => l.id === setup.lineId) ?? null : null

  const pickOpening = (id: string) => {
    const summary = openings?.find((o) => o.id === id)
    onChange({ openingId: id, lineId: RANDOM_LINE, ...(summary ? { color: summary.side } : {}) })
  }

  const toggleOpening = (on: boolean) => {
    if (!on) return onChange({ useOpening: false })
    const valid = openings?.some((o) => o.id === setup.openingId)
    const first = openings?.[0]
    if (!valid && first) onChange({ useOpening: true, openingId: first.id, lineId: RANDOM_LINE, color: first.side })
    else {
      const summary = openings?.find((o) => o.id === setup.openingId)
      onChange({ useOpening: true, ...(summary ? { color: summary.side } : {}) })
    }
  }

  return (
    <div className="play-setup" data-testid="play-setup">
      <section className="play-setup-section">
        <div className="play-setup-label">I play as</div>
        <div className="btn-group play-color-group" role="radiogroup" aria-label="Colour">
          {COLOR_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={setup.color === o.value}
              className={`btn${setup.color === o.value ? ' active' : ''}`}
              data-color={o.value}
              onClick={() => onChange({ color: o.value })}
            >
              {o.value === 'random' ? (
                <span className="play-color-random">?</span>
              ) : (
                <PlayPieceIcon piece="k" color={o.value} />
              )}
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="play-setup-section">
        <div className="play-elo-head">
          <div>
            <div className="play-setup-label">Bot strength</div>
            <div className="play-elo-caption" data-testid="play-strength-caption">
              {strengthCaption(setup.elo)}
            </div>
          </div>
          <div className="play-elo-value">
            <span className="play-elo-number" data-testid="play-elo-value">
              {setup.elo}
            </span>
            <span className="play-elo-level">{eloLevel(setup.elo)}</span>
          </div>
        </div>
        <Slider value={setup.elo} min={ELO_MIN} max={ELO_MAX} step={10} onChange={(v) => onChange({ elo: v })} className="play-elo-slider" />
        <div className="play-elo-presets">
          {ELO_PRESETS.map((e) => (
            <button
              key={e}
              type="button"
              className={`btn btn-sm${setup.elo === e ? ' active' : ''}`}
              onClick={() => onChange({ elo: e })}
              data-elo={e}
            >
              {e}
            </button>
          ))}
        </div>
        <p className="play-setup-note">
          {setup.elo >= UCI_ELO_MIN
            ? 'Stockfish limits itself with its own UCI_LimitStrength / UCI_Elo setting.'
            : 'Below 1320 Stockfish has no Elo setting: a low Skill Level plus random move mixing approximates the strength.'}
        </p>
      </section>

      <section className="play-setup-section">
        <div className="play-setup-label">Bot move time</div>
        <div className="btn-group" role="radiogroup" aria-label="Bot move time">
          {MOVETIME_OPTIONS.map((ms) => (
            <button
              key={ms}
              type="button"
              role="radio"
              aria-checked={setup.movetimeMs === ms}
              className={`btn btn-sm${setup.movetimeMs === ms ? ' active' : ''}`}
              data-movetime={ms}
              onClick={() => onChange({ movetimeMs: ms })}
            >
              {formatMovetime(ms)}
            </button>
          ))}
        </div>
      </section>

      <section className="play-setup-section">
        <Toggle checked={setup.useOpening} onChange={toggleOpening} label="Start from an opening line" disabled={!openings || openings.length === 0} />
        {openingsError ? (
          <div className="play-inline-error">
            <Icon name="warning" size={16} /> Could not load openings: {openingsError}
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}
        {!openings && !openingsError ? (
          <div className="row muted small">
            <Spinner size={14} /> Loading openings...
          </div>
        ) : null}
        {openings && openings.length === 0 ? <div className="muted small">No openings found in data/openings.</div> : null}
        {setup.useOpening && openings && openings.length > 0 ? (
          <div className="play-opening-fields">
            <Select
              label="Opening"
              value={setup.openingId}
              options={openings.map((o) => ({ value: o.id, label: `${o.name} (${o.side === 'white' ? 'White' : 'Black'})` }))}
              onChange={pickOpening}
              className="play-select"
            />
            <Select
              label="Line"
              value={setup.lineId}
              options={lineOptions}
              onChange={(v) => onChange({ lineId: v })}
              disabled={!opening}
              className="play-select"
            />
            {openingError ? (
              <div className="play-inline-error">
                <Icon name="warning" size={16} /> {openingError}
                <button type="button" className="btn btn-sm" onClick={onRetry}>
                  Retry
                </button>
              </div>
            ) : null}
            {!opening && !openingError ? (
              <div className="row muted small">
                <Spinner size={14} /> Loading lines...
              </div>
            ) : null}
            {selectedLine ? (
              <div className="play-line-preview" title={formatSanPath(selectedLine.sans)}>
                <span className="mono">{formatSanPath(selectedLine.sans)}</span>
                {selectedLine.evaluation ? <span className="muted"> ({selectedLine.evaluation})</span> : null}
              </div>
            ) : null}
            <div className="play-mode-group" role="radiogroup" aria-label="How to use the line">
              {(
                [
                  { value: 'hints', title: 'Play the opening with hints', text: 'Play the line yourself: book moves get a green check, a wrong move shows the book move. The bot follows the line.' },
                  { value: 'end', title: 'Start at the end of the line', text: 'The line is played out for you and the game starts from its final position.' },
                ] as { value: OpeningMode; title: string; text: string }[]
              ).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={setup.openingMode === m.value}
                  className={`play-mode${setup.openingMode === m.value ? ' active' : ''}`}
                  data-mode={m.value}
                  onClick={() => onChange({ openingMode: m.value })}
                >
                  <span className="play-mode-radio" />
                  <span className="play-mode-text">
                    <strong>{m.title}</strong>
                    <span>{m.text}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
