/** Right-panel setup card: source (last game / PGN), depth, model, start button and progress. */
import type { JSX, ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import type { LastGame } from '../../state/AppContext'
import { sideName, timeAgo } from './reviewUtils'

export type ReviewSource = 'last' | 'pgn'

const REVIEW_DEPTHS: readonly { depth: number; label: string; hint: string }[] = [
  { depth: 12, label: 'Fast', hint: 'depth 12' },
  { depth: 16, label: 'Default', hint: 'depth 16' },
  { depth: 20, label: 'Deep', hint: 'depth 20' },
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
  lastGame: LastGame | null
  pgnText: string
  onPgnText: (t: string) => void
  depth: number
  onDepth: (d: number) => void
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
  const { source, onSource, lastGame, pgnText, onPgnText, depth, onDepth, modelPicker, run, error, canStart, onStart, onCancel } = props
  const busy = run !== null
  const customDepth = !REVIEW_DEPTHS.some((d) => d.depth === depth)

  return (
    <div className="panel grow review-setup" data-testid="review-setup">
      <div className="panel-header">
        <Icon name="review" size={18} />
        <span className="panel-title">Game Review</span>
      </div>
      <div className="panel-body scroll col gap-16">
        <p className="muted review-setup-intro">
          Stockfish checks every move (brilliant to blunder) and scores both players' accuracy; a local Ollama model
          explains the key moments.
        </p>

        <div className="col gap-4">
          <span className="review-field-label">Game</span>
          <div className="btn-group review-source">
            <button type="button" className={`btn btn-sm${source === 'last' ? ' active' : ''}`} onClick={() => onSource('last')} disabled={busy}>
              <Icon name="play" size={14} /> Last game
            </button>
            <button type="button" className={`btn btn-sm${source === 'pgn' ? ' active' : ''}`} onClick={() => onSource('pgn')} disabled={busy}>
              <Icon name="upload" size={14} /> Paste PGN
            </button>
          </div>
          {source === 'last' ? (
            lastGame && lastGame.sans.length > 0 ? (
              <div className="review-lastgame card" data-testid="review-lastgame">
                <div className="row">
                  <span className="badge badge-white">{sideName(lastGame.players, 'white')}</span>
                  <span className="muted small">vs</span>
                  <span className="badge badge-black">{sideName(lastGame.players, 'black')}</span>
                  <span className="spacer" />
                  {lastGame.result ? <span className="bold">{lastGame.result}</span> : null}
                </div>
                <div className="small muted">
                  {Math.ceil(lastGame.sans.length / 2)} moves{lastGame.reason ? ` · ${lastGame.reason}` : ''} · {timeAgo(lastGame.playedAt)}
                </div>
              </div>
            ) : (
              <div className="review-empty-note small muted">
                No finished game yet. Play one in the <b>Play</b> tab (it shows up here), or paste a PGN.
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
                <span className="dim">PGN or plain SAN moves. Only the main line is reviewed.</span>
                <span className="spacer" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPgnText(SAMPLE_PGN)} disabled={busy}>
                  Sample
                </button>
              </div>
            </>
          )}
        </div>

        <div className="col gap-4">
          <span className="review-field-label">Engine depth</span>
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
            <label className={`review-depth-custom${customDepth ? ' active' : ''}`} title="Custom depth (4-30)">
              <span className="small muted">Custom</span>
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

        <div className="col gap-4">
          <span className="review-field-label">Explanation model</span>
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
              <span className="dim">{run.message ?? `Stockfish, depth ${depth}`}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onStart} disabled={!canStart} data-testid="review-start">
            <Icon name="review" size={18} /> Start review
          </button>
        )}
      </div>
    </div>
  )
}

function progressLabel(run: ReviewRunInfo): string {
  if (run.status === 'starting') return 'Starting review…'
  if (run.status === 'queued') return 'Waiting for the engine…'
  const done = Math.min(run.totalPlies, Math.round(run.progress * run.totalPlies))
  return `Analysing ply ${Math.max(1, done)} of ${run.totalPlies}`
}
