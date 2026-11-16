/**
 * Game Review's advanced Stockfish settings: CPU threads, hash memory and a time limit per move.
 * A section of the setup card that folds open in place (no separate box), closed by default.
 * Unchanged settings are stored as null, so the review uses the backend's own (the phone's are
 * smaller than the PC's); the backend also lowers anything above what the machine offers.
 */
import { useState, type JSX } from 'react'
import type { ReviewEngineInfo } from '../../api/types'
import { Icon } from '../../components/Icon'
import { Slider } from '../../components/Slider'
import { getLanguage, t, tn } from '../../lib/i18n'
import { loadJson, saveJson } from '../../lib/storage'
import type { ReviewEngineChoice } from '../../state/AppContext'

const OPEN_KEY = 'review-advanced-open-v1'
const SMALLEST_HASH_MB = 16
/** No limit, then 0.5 s to 30 s. */
const MOVE_TIMES: readonly (number | null)[] = [null, 500, 1000, 2000, 5000, 10000, 30000]

/** Powers of two up to the machine's limit, plus the backend's own size if it is not one. */
function hashSizes(info: ReviewEngineInfo): number[] {
  const sizes = new Set<number>([info.hashMb])
  for (let mb = SMALLEST_HASH_MB; mb <= info.maxHashMb; mb *= 2) sizes.add(mb)
  return [...sizes].sort((a, b) => a - b)
}

/** What a review runs with: the choice, else the backend's own, within the machine's limits. */
function effectiveEngine(choice: ReviewEngineChoice, info: ReviewEngineInfo): { threads: number; hashMb: number; moveTimeMs: number | null } {
  return {
    threads: Math.min(choice.threads ?? info.threads, info.maxThreads),
    hashMb: Math.min(choice.hashMb ?? info.hashMb, info.maxHashMb),
    moveTimeMs: choice.moveTimeMs,
  }
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat(getLanguage()).format(n)
}

function sizeText(mb: number): string {
  return mb >= 1024 ? t('{n} GB', { n: formatNumber(mb / 1024) }) : t('{n} MB', { n: mb })
}

function timeText(ms: number | null): string {
  return ms === null ? t('No limit') : t('{n} s', { n: formatNumber(ms / 1000) })
}

function threadsText(n: number): string {
  return tn(n, '{n} thread', '{n} threads')
}

export interface ReviewEngineSettingsProps {
  choice: ReviewEngineChoice
  /** The backend's own settings and the machine's limits (from /api/health). */
  info: ReviewEngineInfo
  onChange: (choice: ReviewEngineChoice) => void
  disabled: boolean
}

export function ReviewEngineSettings({ choice, info, onChange, disabled }: ReviewEngineSettingsProps): JSX.Element {
  const [open, setOpen] = useState(() => loadJson<boolean>(OPEN_KEY, false) === true)
  const current = effectiveEngine(choice, info)
  const sizes = hashSizes(info)
  const hashIndex = Math.max(0, sizes.findLastIndex((mb) => mb <= current.hashMb))
  const timeIndex = Math.max(0, MOVE_TIMES.indexOf(current.moveTimeMs))
  const changed = choice.threads !== null || choice.hashMb !== null || choice.moveTimeMs !== null
  const summary = [threadsText(current.threads), sizeText(current.hashMb), current.moveTimeMs ? timeText(current.moveTimeMs) : null]
    .filter(Boolean)
    .join(' · ')

  const toggle = (): void => {
    setOpen(!open)
    saveJson(OPEN_KEY, !open)
  }
  const set = (patch: Partial<ReviewEngineChoice>): void => onChange({ ...choice, ...patch })

  return (
    <div className={`review-advanced${open ? ' open' : ''}`} data-testid="review-advanced">
      <button type="button" className="review-advanced-toggle" aria-expanded={open} onClick={toggle} data-testid="review-advanced-toggle">
        <span className="review-field-label">{t('Advanced Stockfish settings')}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={15} className="review-advanced-chevron" />
        <span className="spacer" />
        {open ? null : (
          <span className="small dim review-advanced-summary" data-testid="review-advanced-summary">
            {summary}
          </span>
        )}
      </button>
      {open ? (
        <div className="review-advanced-body" data-testid="review-advanced-body">
          <Slider
            className="review-advanced-threads"
            label={t('CPU threads')}
            value={current.threads}
            min={1}
            max={info.maxThreads}
            onChange={(n) => set({ threads: n === info.threads ? null : n })}
            format={threadsText}
            disabled={disabled}
          />
          <Slider
            className="review-advanced-hash"
            label={t('Hash memory')}
            value={hashIndex}
            min={0}
            max={sizes.length - 1}
            onChange={(i) => set({ hashMb: sizes[i] === info.hashMb ? null : sizes[i] })}
            format={(i) => sizeText(sizes[i])}
            disabled={disabled}
          />
          <Slider
            className="review-advanced-time"
            label={t('Time limit per move')}
            value={timeIndex}
            min={0}
            max={MOVE_TIMES.length - 1}
            onChange={(i) => set({ moveTimeMs: MOVE_TIMES[i] })}
            format={(i) => timeText(MOVE_TIMES[i])}
            disabled={disabled}
          />
          <p className="small dim review-advanced-note">
            {t('More threads and memory search each position faster. The time limit moves on when a position would take longer to reach the depth.')}
          </p>
          {changed ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm review-advanced-reset"
              onClick={() => onChange({ threads: null, hashMb: null, moveTimeMs: null })}
              disabled={disabled}
              data-testid="review-advanced-reset"
            >
              <Icon name="refresh" size={14} /> {t('Reset to defaults')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
