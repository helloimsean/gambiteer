import { useMemo, type JSX, type KeyboardEvent } from 'react'
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
  MAIA_ELO_MAX,
  MAIA_ELO_MIN,
  MAIA_ELO_PRESETS,
  MAIA_ELO_STEP,
  MOVETIME_OPTIONS,
  RANDOM_LINE,
  UCI_ELO_MIN,
  eloLevel,
  formatMovetime,
  setupElo,
  strengthCaption,
  type ColorChoice,
  type MaiaStatus,
  type OpeningMode,
  type PlaySetup,
} from './PlayGame'
import { PlayPieceIcon } from './PlayPlayerBar'

export interface PlaySetupFormProps {
  setup: PlaySetup
  maiaStatus: MaiaStatus
  /** Ratings with an installed net; null when not known yet. */
  maiaRatings: readonly number[] | null
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

const STOCKFISH_BLURB = 'The strongest chess engine, held back to the Elo you choose.'
const MAIA_BLURB = 'A neural network trained on millions of real online games. It plays like a person at that rating, including human-style mistakes.'
const MAIA_RATING_NOTE = 'Maia has one trained model per 100 rating points, from 1100 to 1900. These are Lichess ratings and the match is approximate.'
const MAIA_MOVE_TIME_NOTE = "Maia doesn't search, so this is just how long it waits before answering."
const MAIA_INSTALL_COMMAND = 'python tools\\install_maia.py'
const ELO_EXPLAINER = 'Elo is a chess rating: higher means stronger. Beginners are around 800, club players around 1500, masters 2200 and up. Lichess ratings run higher than chess.com ones.'
const MAIA_RATING_COUNT = (MAIA_ELO_MAX - MAIA_ELO_MIN) / MAIA_ELO_STEP + 1

/** Arrow keys move through a radio group and select, as native radio buttons do. */
function moveInRadioGroup(e: KeyboardEvent<HTMLElement>): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (step === 0) return
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])'))
  const at = radios.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  e.preventDefault()
  const next = radios[(at + step + radios.length) % radios.length]
  next.focus()
  next.click()
}

/** The new-game settings (used inline in the side panel and inside the New game dialog). */
export function PlaySetupForm({ setup, maiaStatus, maiaRatings, onChange, openings, openingsError, opening, openingError, onRetry }: PlaySetupFormProps): JSX.Element {
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
  const isMaia = setup.bot === 'maia'
  const elo = setupElo(setup)
  const setElo = (value: number) => onChange(isMaia ? { maiaElo: value } : { elo: value })
  const presets: readonly number[] = isMaia ? MAIA_ELO_PRESETS : ELO_PRESETS
  const missingRating = (rating: number) => isMaia && maiaRatings !== null && !maiaRatings.includes(rating)
  // a partial install (an interrupted download): the slider steps through the installed ratings only
  const partial = isMaia && maiaRatings && maiaRatings.length > 0 && maiaRatings.length < MAIA_RATING_COUNT ? maiaRatings : null
  const movetimeSelected = (MOVETIME_OPTIONS as readonly number[]).includes(setup.movetimeMs)

  const maiaCardBody = (
    <>
      <span className="play-mode-radio" />
      <span className="play-mode-text">
        <span className="play-bot-title">
          <strong>Maia</strong>
          <span className="badge badge-blue" data-testid="play-maia-pill">
            More human-like
          </span>
        </span>
        <span>{MAIA_BLURB}</span>
        {maiaStatus === 'missing' ? (
          <span className="play-bot-install" data-testid="play-maia-install">
            Not installed. To add it, run <code>{MAIA_INSTALL_COMMAND}</code>, then restart.
          </span>
        ) : null}
      </span>
    </>
  )

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
        <div className="btn-group play-color-group" role="radiogroup" aria-label="Colour" onKeyDown={moveInRadioGroup}>
          {COLOR_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={setup.color === o.value}
              tabIndex={setup.color === o.value ? 0 : -1}
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
        <div className="play-setup-label">Opponent</div>
        <div className="play-mode-group" role="radiogroup" aria-label="Opponent" onKeyDown={moveInRadioGroup}>
          <button
            type="button"
            role="radio"
            aria-checked={!isMaia}
            tabIndex={isMaia ? -1 : 0}
            className={`play-mode${isMaia ? '' : ' active'}`}
            data-bot="stockfish"
            onClick={() => onChange({ bot: 'stockfish' })}
          >
            <span className="play-mode-radio" />
            <span className="play-mode-text">
              <strong>Stockfish</strong>
              <span>{STOCKFISH_BLURB}</span>
            </span>
          </button>
          {maiaStatus === 'missing' ? (
            // a plain element rather than a disabled button, so the install command can be selected and copied
            <div role="radio" aria-checked={false} aria-disabled="true" className="play-mode disabled" data-bot="maia">
              {maiaCardBody}
            </div>
          ) : (
            <button
              type="button"
              role="radio"
              aria-checked={isMaia}
              tabIndex={isMaia ? 0 : -1}
              className={`play-mode${isMaia ? ' active' : ''}`}
              data-bot="maia"
              onClick={() => onChange({ bot: 'maia' })}
            >
              {maiaCardBody}
            </button>
          )}
        </div>
      </section>

      <section className="play-setup-section">
        <div className="play-elo-head">
          <div>
            <div className="play-setup-label">Bot strength (Elo)</div>
            <div className="play-elo-caption" data-testid="play-strength-caption">
              {strengthCaption(setup.bot, elo)}
            </div>
          </div>
          <div className="play-elo-value">
            <span className="play-elo-number" data-testid="play-elo-value">
              {elo}
            </span>
            <span className="play-elo-level">{eloLevel(elo)}</span>
          </div>
        </div>
        <p className="play-setup-note" data-testid="play-elo-explainer">
          {ELO_EXPLAINER}
        </p>
        {/* keyed by bot: a range input that gets a new min, max and value together can clamp to the old limits */}
        <Slider
          key={partial ? partial.join() : setup.bot}
          value={partial ? partial.indexOf(elo) : elo}
          min={partial ? 0 : isMaia ? MAIA_ELO_MIN : ELO_MIN}
          max={partial ? partial.length - 1 : isMaia ? MAIA_ELO_MAX : ELO_MAX}
          step={partial ? 1 : isMaia ? MAIA_ELO_STEP : 10}
          onChange={(value) => setElo(partial ? partial[value] : value)}
          className="play-elo-slider"
        />
        <div className="play-elo-presets">
          {presets.map((e) => (
            <button
              key={e}
              type="button"
              className={`btn btn-sm${elo === e ? ' active' : ''}`}
              onClick={() => setElo(e)}
              disabled={missingRating(e)}
              title={missingRating(e) ? 'This model is not installed' : undefined}
              data-elo={e}
            >
              {e}
            </button>
          ))}
        </div>
        <p className="play-setup-note" data-testid="play-strength-note">
          {isMaia
            ? MAIA_RATING_NOTE
            : elo >= UCI_ELO_MIN
              ? 'Stockfish limits itself to this rating.'
              : "Stockfish can't limit itself this low, so it plays weaker moves on purpose. The rating is approximate."}
        </p>
        {partial ? (
          <p className="play-setup-note" data-testid="play-maia-partial">
            Some of Maia&apos;s models are not installed. To add them, run <code>{MAIA_INSTALL_COMMAND}</code>, then restart.
          </p>
        ) : null}
      </section>

      <section className="play-setup-section">
        <div className="play-setup-label">Bot move time</div>
        <div className="btn-group" role="radiogroup" aria-label="Bot move time" onKeyDown={moveInRadioGroup}>
          {MOVETIME_OPTIONS.map((ms) => (
            <button
              key={ms}
              type="button"
              role="radio"
              aria-checked={setup.movetimeMs === ms}
              tabIndex={setup.movetimeMs === ms || !movetimeSelected ? 0 : -1}
              className={`btn btn-sm${setup.movetimeMs === ms ? ' active' : ''}`}
              data-movetime={ms}
              onClick={() => onChange({ movetimeMs: ms })}
            >
              {formatMovetime(ms)}
            </button>
          ))}
        </div>
        {isMaia ? (
          <p className="play-setup-note" data-testid="play-movetime-note">
            {MAIA_MOVE_TIME_NOTE}
          </p>
        ) : null}
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
            <div className="play-mode-group" role="radiogroup" aria-label="How to use the line" onKeyDown={moveInRadioGroup}>
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
                  tabIndex={setup.openingMode === m.value ? 0 : -1}
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
