/** Right-panel setup card: source (selected game / PGN), depth, model, start button and progress. */
import { useState, type JSX, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { PgnFileButton } from '../../components/PgnFileButton'
import { Spinner } from '../../components/Spinner'
import { t, tn } from '../../lib/i18n'
import type { LastGame } from '../../state/AppContext'
import { sideName, timeAgo } from './reviewUtils'

export type ReviewSource = 'last' | 'pgn'

const REVIEW_DEPTHS: readonly { depth: number; label: string; hint: string }[] = [
  { depth: 12, label: t('Fast'), hint: t('depth 12') },
  { depth: 16, label: t('Default'), hint: t('depth 16') },
  { depth: 20, label: t('Deep'), hint: t('depth 20') },
]

export interface ReviewRunInfo {
  progress: number
  message?: string
  totalPlies: number
  status: 'starting' | 'queued' | 'running'
}

export interface ReviewSetupProps {
  source: ReviewSource
  onSource: (s: ReviewSource) => void
  /** The last game played, or the game sent from History. */
  selectedGame: LastGame | null
  selectedLabel: string
  pgnText: string
  onPgnText: (t: string) => void
  depth: number
  onDepth: (d: number) => void
  /** The advanced Stockfish settings (absent when the backend does not report them). */
  engineSettings?: ReactNode
  /** The model picker (or the Ollama-down note). */
  modelPicker: ReactNode
  run: ReviewRunInfo | null
  error: string | null
  canStart: boolean
  onStart: () => void
  onCancel: () => void
}

const SAMPLE_PGN = [
  '[White "Legal"]',
  '[Black "Saint Brie"]',
  '[Result "1-0"]',
  '',
  '1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0',
].join('\n')

export function ReviewSetup(props: ReviewSetupProps): JSX.Element {
  const { source, onSource, selectedGame, selectedLabel, pgnText, onPgnText, depth, onDepth, engineSettings, modelPicker, run, error, canStart, onStart, onCancel } =
    props
  const busy = run !== null
  const customDepth = !REVIEW_DEPTHS.some((d) => d.depth === depth)
  const [fileError, setFileError] = useState<string | null>(null)

  return (
    <div className="panel grow review-setup" data-testid="review-setup">
      <div className="panel-header">
        <Icon name="review" size={18} />
        <span className="panel-title">{t('Game Review')}</span>
      </div>
      <div className="panel-body scroll col gap-16">
        <p className="muted review-setup-intro">
          {t(
            "Stockfish checks every move (brilliant to blunder) and scores both players' accuracy; a local Ollama model explains the key moments.",
          )}
        </p>

        <div className="col gap-4">
          <span className="review-field-label">{t('Game')}</span>
          <div className="btn-group review-source">
            <button type="button" className={`btn btn-sm${source === 'last' ? ' active' : ''}`} onClick={() => onSource('last')} disabled={busy}>
              <Icon name="play" size={14} /> {selectedLabel}
            </button>
            <button type="button" className={`btn btn-sm${source === 'pgn' ? ' active' : ''}`} onClick={() => onSource('pgn')} disabled={busy}>
              <Icon name="upload" size={14} /> {t('Import PGN')}
            </button>
          </div>
          {source === 'last' ? (
            selectedGame && selectedGame.sans.length > 0 ? (
              <div className="review-lastgame card" data-testid="review-lastgame">
                <div className="row">
                  <span className="badge badge-white">{sideName(selectedGame.players, 'white')}</span>
                  <span className="muted small">{t('vs')}</span>
                  <span className="badge badge-black">{sideName(selectedGame.players, 'black')}</span>
                  <span className="spacer" />
                  {selectedGame.result ? <span className="bold">{selectedGame.result}</span> : null}
                </div>
                <div className="small muted">
                  {tn(Math.ceil(selectedGame.sans.length / 2), '{n} move', '{n} moves')}
                  {selectedGame.reason ? ` · ${selectedGame.reason}` : ''} · {timeAgo(selectedGame.playedAt)}
                </div>
              </div>
            ) : (
              <div className="review-empty-note small muted">
                {t('No finished game yet. Play one in the')} <b>{t('Play')}</b> {t('tab (it shows up here), or import a PGN.')}
              </div>
            )
          ) : (
            <>
              <textarea
                className="review-pgn"
                value={pgnText}
                onChange={(e) => onPgnText(e.target.value)}
                placeholder={'[White "Me"]\n[Black "Friend"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 ...'}
                spellCheck={false}
                rows={7}
                disabled={busy}
                data-testid="review-pgn"
              />
              <div className="row small">
                <PgnFileButton
                  onText={(text) => {
                    setFileError(null)
                    onPgnText(text)
                  }}
                  onError={setFileError}
                  disabled={busy}
                />
                <span className="spacer" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPgnText(SAMPLE_PGN)} disabled={busy}>
                  {t('Sample')}
                </button>
              </div>
              <span className="dim small">
                {t('Paste a PGN or plain SAN moves, or open a file. Only the main line of the first game is reviewed.')}
              </span>
              {fileError ? (
                <div className="review-error" role="alert" data-testid="review-file-error">
                  <Icon name="warning" size={16} /> <span>{fileError}</span>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="col gap-4">
          <span className="review-field-label">{t('Engine depth')}</span>
          <div className="row wrap">
            <div className="btn-group review-depths">
              {REVIEW_DEPTHS.map((d) => (
                <button
                  key={d.depth}
                  type="button"
                  className={`btn btn-sm${depth === d.depth ? ' active' : ''}`}
                  title={d.hint}
                  onClick={() => onDepth(d.depth)}
                  disabled={busy}
                >
                  {d.depth} <span className="review-depth-hint">{d.label}</span>
                </button>
              ))}
            </div>
            <label className={`review-depth-custom${customDepth ? ' active' : ''}`} title={t('Custom depth (4-30)')}>
              <span className="small muted">{t('Custom')}</span>
              <input
                type="number"
                min={4}
                max={30}
                value={depth}
                disabled={busy}
                onChange={(e) => {
                  // accept 1..30 while typing ("1" on the way to "10"); clamped to 4..30 on blur and on start
                  const v = Math.round(Number(e.target.value))
                  if (Number.isFinite(v) && v >= 1 && v <= 30) onDepth(v)
                }}
                onBlur={() => {
                  if (depth < 4) onDepth(4)
                }}
                data-testid="review-depth-input"
              />
            </label>
          </div>
        </div>

        {engineSettings}

        <div className="col gap-4">
          <span className="review-field-label">{t('Explanation model')}</span>
          {modelPicker}
        </div>

        {error ? (
          <div className="review-error" role="alert" data-testid="review-error">
            <Icon name="warning" size={16} /> <span>{error}</span>
          </div>
        ) : null}
      </div>
      <div className="panel-footer review-setup-footer">
        {run ? (
          <div className="review-progress-box" data-testid="review-progress">
            <div className="row">
              <Spinner size={16} />
              <span className="bold" data-testid="review-progress-label">
                {progressLabel(run)}
              </span>
              <span className="spacer" />
              <span className="mono small">{Math.round(run.progress * 100)}%</span>
            </div>
            <div className="progress review-progress-bar">
              <span style={{ width: `${Math.max(2, run.progress * 100).toFixed(1)}%` }} />
            </div>
            <div className="row small">
              <span className="dim">{run.message ?? t('Stockfish, depth {depth}', { depth })}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onStart} disabled={!canStart} data-testid="review-start">
            <Icon name="review" size={18} /> {t('Game Review')}
          </button>
        )}
      </div>
    </div>
  )
}

function progressLabel(run: ReviewRunInfo): string {
  if (run.status === 'starting') return t('Starting review…')
  if (run.status === 'queued') return t('Waiting for the engine…')
  const done = Math.min(run.totalPlies, Math.round(run.progress * run.totalPlies))
  return t('Analysing ply {ply} of {total}', { ply: Math.max(1, done), total: run.totalPlies })
}
