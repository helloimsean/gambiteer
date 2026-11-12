import { useMemo, type JSX, type KeyboardEvent } from 'react'
import { LINE_CATEGORIES, LINE_CATEGORY_LABELS, type OpeningFull, type OpeningSummary } from '../../api/types'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { Slider } from '../../components/Slider'
import { Spinner } from '../../components/Spinner'
import { Toggle } from '../../components/Toggle'
import { formatSanPath } from '../../lib/chess'
import { t } from '../../lib/i18n'
import { VARIANTS, variantInfo } from '../../lib/variants'
import {
  ELO_MAX,
  ELO_MIN,
  ELO_PRESETS,
  NAME_MAX,
  MAIA_ELO_MAX,
  MAIA_ELO_MIN,
  MAIA_ELO_PRESETS,
  MAIA_ELO_STEP,
  MOVETIME_OPTIONS,
  PANICFISH_ELO_PER_CHECK,
  PANICFISH_START_ELO,
  RANDOM_LINE,
  UCI_ELO_MIN,
  colorIsLocked,
  eloLevel,
  formatMovetime,
  setupElo,
  strengthCaption,
  variantBlocked,
  type ColorChoice,
  type FairyStatus,
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
  fairyStatus: FairyStatus
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
  { value: 'white', label: t('White') },
  { value: 'random', label: t('Random') },
  { value: 'black', label: t('Black') },
]

const STOCKFISH_BLURB = t('The strongest chess engine, held back to the Elo you choose.')
const MAIA_BLURB = t('A neural network trained on millions of real online games. It plays like a person at that rating, including human-style mistakes.')
const MAIA_RATING_NOTE = t('Maia has one trained model per 100 rating points, from 1100 to 1900. These are Lichess ratings and the match is approximate.')
const MAIA_MOVE_TIME_NOTE = t("Maia doesn't search, so this is just how long it waits before answering.")
const MAIA_INSTALL_COMMAND = 'python tools\\install_maia.py'
const FAIRY_INSTALL_COMMAND = 'python tools\\install_fairy.py'
const PANICFISH_BLURB = t('I am Stockfish 19 that loses {per} Elo every time you check me. I start at full {start} grandmaster strength and slowly lose more sanity with each check.', {
  per: PANICFISH_ELO_PER_CHECK,
  start: PANICFISH_START_ELO,
})
const PANICFISH_CHECKS_TO_ZERO = PANICFISH_START_ELO / PANICFISH_ELO_PER_CHECK
const FAIRY_NOTE = t('Stockfish 19 only plays standard chess and Chess960, so Fairy-Stockfish plays this variant. Elo is only a rough guide here.')
const ELO_EXPLAINER = t('Elo is a chess rating: higher means stronger. Beginners are around 800, club players around 1500, masters 2200 and up. Lichess ratings run higher than chess.com ones.')
const MAIA_RATING_COUNT = (MAIA_ELO_MAX - MAIA_ELO_MIN) / MAIA_ELO_STEP + 1
const OTB_BLURB = t('Play a friend on this device. The board turns to face whoever is to move.')
const OTB_NOTE = t('Pass the device after each move. Engine hints are off; you can take back moves and agree to a draw.')

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
export function PlaySetupForm({ setup, maiaStatus, maiaRatings, fairyStatus, onChange, openings, openingsError, opening, openingError, onRetry }: PlaySetupFormProps): JSX.Element {
  const lineOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: RANDOM_LINE, label: t('Random line') }]
    if (!opening) return opts
    for (const cat of LINE_CATEGORIES) {
      for (const l of opening.lines) {
        if (l.category === cat) opts.push({ value: l.id, label: t('{category}: {name} ({count} plies)', { category: LINE_CATEGORY_LABELS[cat], name: l.name, count: l.sans.length }) })
      }
    }
    return opts
  }, [opening])

  const selectedLine = opening && setup.lineId !== RANDOM_LINE ? opening.lines.find((l) => l.id === setup.lineId) ?? null : null
  const isOtb = setup.mode === 'otb'
  const isMaia = !isOtb && setup.bot === 'maia'
  const isPanicfish = !isOtb && setup.bot === 'panicfish'
  const isStockfish = !isOtb && setup.bot === 'stockfish'
  const variant = variantInfo(setup.variant)
  const isStandard = setup.variant === 'standard'
  const usesFairy = variant.engine === 'fairy'
  const maiaUnplayable = maiaStatus === 'missing' || !isStandard
  const colorLocked = colorIsLocked(setup)
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
            {t('More human-like')}
          </span>
        </span>
        <span>{MAIA_BLURB}</span>
        {maiaStatus === 'missing' ? (
          <span className="play-bot-install" data-testid="play-maia-install">
            {t('Not installed. To add it, run')} <code>{MAIA_INSTALL_COMMAND}</code>{t(', then restart.')}
          </span>
        ) : !isStandard ? (
          <span className="play-bot-install" data-testid="play-maia-standard-only">
            {t('Only plays standard chess.')}
          </span>
        ) : null}
      </span>
    </>
  )

  const panicfishCardBody = (
    <>
      <span className="play-mode-radio" />
      <span className="play-mode-text">
        <strong>Panicfish</strong>
        <span>{PANICFISH_BLURB}</span>
        {variant.hasChecks ? null : (
          <span className="play-bot-install" data-testid="play-panicfish-blocked">
            {t('{variant} has no checks, so it would never lose any Elo.', { variant: variant.name })}
          </span>
        )}
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
      <section className="play-setup-section" data-testid="play-variant">
        <Select label={t('Variant')} value={setup.variant} options={VARIANTS.map((v) => ({ value: v.id, label: v.name }))} onChange={(v) => onChange({ variant: v })} className="play-variant-select" />
        <p className="play-setup-note" data-testid="play-variant-rule">
          {variant.rule}
        </p>
        {variantBlocked(setup.variant, fairyStatus) && !isOtb ? (
          <p className="play-setup-note play-bot-install" data-testid="play-fairy-install">
            {t('{variant} needs the Fairy-Stockfish engine. To add it, run', { variant: variant.name })} <code>{FAIRY_INSTALL_COMMAND}</code>{t(', then restart.')}
          </p>
        ) : null}
      </section>

      {isOtb ? null : (
      <section className="play-setup-section">
        <div className="play-setup-label">{t('I play as')}</div>
        <div className="btn-group play-color-group" role="radiogroup" aria-label={t('Colour')} onKeyDown={moveInRadioGroup}>
          {COLOR_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={setup.color === o.value}
              tabIndex={setup.color === o.value ? 0 : -1}
              className={`btn${setup.color === o.value ? ' active' : ''}`}
              data-color={o.value}
              disabled={colorLocked && o.value !== 'white'}
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
        {colorLocked ? (
          <p className="play-setup-note" data-testid="play-color-locked">
            {t('Only Black has a king in Horde, so you play the pawns against Panicfish.')}
          </p>
        ) : null}
      </section>
      )}

      <section className="play-setup-section">
        <div className="play-setup-label">{t('Opponent')}</div>
        <div className="play-mode-group" role="radiogroup" aria-label={t('Opponent')} onKeyDown={moveInRadioGroup}>
          <button
            type="button"
            role="radio"
            aria-checked={isStockfish}
            tabIndex={isStockfish ? 0 : -1}
            className={`play-mode${isStockfish ? ' active' : ''}`}
            data-bot="stockfish"
            onClick={() => onChange({ mode: 'bot', bot: 'stockfish' })}
          >
            <span className="play-mode-radio" />
            <span className="play-mode-text">
              <strong>{usesFairy ? 'Fairy-Stockfish' : 'Stockfish'}</strong>
              <span>{STOCKFISH_BLURB}</span>
            </span>
          </button>
          {maiaUnplayable ? (
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
              onClick={() => onChange({ mode: 'bot', bot: 'maia' })}
            >
              {maiaCardBody}
            </button>
          )}
          {variant.hasChecks ? (
            <button
              type="button"
              role="radio"
              aria-checked={isPanicfish}
              tabIndex={isPanicfish ? 0 : -1}
              className={`play-mode${isPanicfish ? ' active' : ''}`}
              data-bot="panicfish"
              onClick={() => onChange({ mode: 'bot', bot: 'panicfish' })}
            >
              {panicfishCardBody}
            </button>
          ) : (
            <div role="radio" aria-checked={false} aria-disabled="true" className="play-mode disabled" data-bot="panicfish">
              {panicfishCardBody}
            </div>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={isOtb}
            tabIndex={isOtb ? 0 : -1}
            className={`play-mode${isOtb ? ' active' : ''}`}
            data-bot="otb"
            onClick={() => onChange({ mode: 'otb' })}
          >
            <span className="play-mode-radio" />
            <span className="play-mode-text">
              <strong>{t('Over the board')}</strong>
              <span>{OTB_BLURB}</span>
            </span>
          </button>
        </div>
      </section>

      {isOtb ? (
        <section className="play-setup-section" data-testid="play-otb">
          <div className="play-setup-label">{t('Players')}</div>
          <div className="play-otb-names">
            {(['white', 'black'] as const).map((side) => (
              <label key={side} className="play-otb-name">
                <PlayPieceIcon piece="k" color={side} />
                <input
                  type="text"
                  value={side === 'white' ? setup.whiteName : setup.blackName}
                  placeholder={side === 'white' ? t('White') : t('Black')}
                  maxLength={NAME_MAX}
                  aria-label={side === 'white' ? t('White player name') : t('Black player name')}
                  onChange={(e) => onChange(side === 'white' ? { whiteName: e.target.value } : { blackName: e.target.value })}
                  data-testid={`play-otb-name-${side}`}
                />
              </label>
            ))}
          </div>
          <Toggle checked={setup.autoFlip} onChange={(v) => onChange({ autoFlip: v })} label={t('Turn the board after every move')} />
          <p className="play-setup-note">{OTB_NOTE}</p>
        </section>
      ) : isPanicfish ? (
        <section className="play-setup-section">
          <div className="play-setup-label">{t('Bot strength (Elo)')}</div>
          <p className="play-setup-note" data-testid="play-panicfish-note">
            {t('Starts at {start} with no limit on its strength. After {checks} checks it reaches 0 Elo and plays random moves.', {
              start: PANICFISH_START_ELO,
              checks: PANICFISH_CHECKS_TO_ZERO,
            })}
            {usesFairy ? ` ${FAIRY_NOTE}` : ''}
          </p>
        </section>
      ) : (
      <section className="play-setup-section">
        <div className="play-elo-head">
          <div>
            <div className="play-setup-label">{t('Bot strength (Elo)')}</div>
            <div className="play-elo-caption" data-testid="play-strength-caption">
              {strengthCaption(setup.bot, elo, setup.variant)}
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
              title={missingRating(e) ? t('This model is not installed') : undefined}
              data-elo={e}
            >
              {e}
            </button>
          ))}
        </div>
        <p className="play-setup-note" data-testid="play-strength-note">
          {isMaia
            ? MAIA_RATING_NOTE
            : usesFairy
              ? FAIRY_NOTE
              : elo >= UCI_ELO_MIN
              ? t('Stockfish limits itself to this rating.')
              : t("Stockfish can't limit itself this low, so it plays weaker moves on purpose. The rating is approximate.")}
        </p>
        {partial ? (
          <p className="play-setup-note" data-testid="play-maia-partial">
            {t("Some of Maia's models are not installed. To add them, run")} <code>{MAIA_INSTALL_COMMAND}</code>{t(', then restart.')}
          </p>
        ) : null}
      </section>
      )}

      {isOtb ? null : (
      <section className="play-setup-section">
        <div className="play-setup-label">{t('Bot move time')}</div>
        <div className="btn-group" role="radiogroup" aria-label={t('Bot move time')} onKeyDown={moveInRadioGroup}>
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
      )}

      {isStandard && !isOtb ? (
      <section className="play-setup-section">
        <Toggle checked={setup.useOpening} onChange={toggleOpening} label={t('Start from an opening line')} disabled={!openings || openings.length === 0} />
        {openingsError ? (
          <div className="play-inline-error">
            <Icon name="warning" size={16} /> {t('Could not load openings: {error}', { error: openingsError })}
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              {t('Retry')}
            </button>
          </div>
        ) : null}
        {!openings && !openingsError ? (
          <div className="row muted small">
            <Spinner size={14} /> {t('Loading openings...')}
          </div>
        ) : null}
        {openings && openings.length === 0 ? <div className="muted small">{t('No openings found in data/openings.')}</div> : null}
        {setup.useOpening && openings && openings.length > 0 ? (
          <div className="play-opening-fields">
            <Select
              label={t('Opening')}
              value={setup.openingId}
              options={openings.map((o) => ({ value: o.id, label: t('{name} ({side})', { name: o.name, side: o.side === 'white' ? t('White') : t('Black') }) }))}
              onChange={pickOpening}
              className="play-select"
            />
            <Select
              label={t('Line')}
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
                  {t('Retry')}
                </button>
              </div>
            ) : null}
            {!opening && !openingError ? (
              <div className="row muted small">
                <Spinner size={14} /> {t('Loading lines...')}
              </div>
            ) : null}
            {selectedLine ? (
              <div className="play-line-preview" title={formatSanPath(selectedLine.sans)}>
                <span className="mono">{formatSanPath(selectedLine.sans)}</span>
                {selectedLine.evaluation ? <span className="muted"> ({selectedLine.evaluation})</span> : null}
              </div>
            ) : null}
            <div className="play-mode-group" role="radiogroup" aria-label={t('How to use the line')} onKeyDown={moveInRadioGroup}>
              {(
                [
                  { value: 'hints', title: t('Play the opening with hints'), text: t('Play the line yourself: book moves get a green check, a wrong move shows the book move. The bot follows the line.') },
                  { value: 'end', title: t('Start at the end of the line'), text: t('The line is played out for you and the game starts from its final position.') },
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
      ) : null}
    </div>
  )
}
