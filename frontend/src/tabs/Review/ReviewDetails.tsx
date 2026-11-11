/**
 * Details of the selected move: classification verdict, eval before -> after, the engine's best
 * move and line, the opening "why" for book moves, and the coach (LLM) explanation panel.
 */
import type { JSX } from 'react'
import type { Players, ReviewMove, ReviewResult } from '../../api/types'
import { CLASSIFICATION_COLORS, ClassificationBadge } from '../../components/ClassificationBadge'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import { formatSanPath, moveNumberPrefix } from '../../lib/chess'
import { formatScore } from '../../lib/eval'
import { t, tn } from '../../lib/i18n'
import { ReviewModelPicker, ReviewOllamaDown } from './ReviewModelPicker'
import { classificationSentence, friendlyExplainError, reviewPlyOffset, sideName } from './reviewUtils'
import type { ReviewExplainApi } from './useReviewExplain'
import type { ReviewModelsState } from './useReviewModels'
import type { VariationMove } from './useReviewVariation'

export interface ReviewDetailsProps {
  result: ReviewResult
  ply: number
  /** A move tried on the board, shown instead of the game's move. */
  tried: { move: VariationMove; absPly: number } | null
  onPlayBest: () => void
  onRetryTried: (move: VariationMove) => void
  players?: Players
  explain: ReviewExplainApi
  models: ReviewModelsState & { retry: () => void }
  /** Stored model setting ("" = backend default). */
  modelValue: string
  onModel: (model: string) => void
  /** Model that will actually be used (for labels). */
  effectiveModel: string
  keyPlies: number[]
  onExplainAll: () => void
  onJump: (ply: number) => void
}

const LINE_PLIES = 10

export function ReviewDetails(props: ReviewDetailsProps): JSX.Element {
  const { result, ply, players, tried, onPlayBest, onRetryTried } = props
  const offset = reviewPlyOffset(result)
  const move: ReviewMove | null = ply > 0 ? (result.moves[ply - 1] ?? null) : null

  if (tried) {
    return (
      <div className="review-details" data-testid="review-details">
        <TriedFacts move={tried.move} absPly={tried.absPly} players={players} onPlayBest={onPlayBest} onRetry={onRetryTried} />
      </div>
    )
  }

  return (
    <div className="review-details" data-testid="review-details">
      {move ? (
        <MoveFacts move={move} absPly={offset + move.ply} players={players} onPlayBest={onPlayBest} />
      ) : (
        <StartFacts result={result} keyCount={props.keyPlies.length} />
      )}
      <ExplainPanel {...props} move={move} />
    </div>
  )
}

interface TriedFactsProps {
  move: VariationMove
  absPly: number
  players?: Players
  onPlayBest: () => void
  onRetry: (move: VariationMove) => void
}

function TriedFacts({ move, absPly, players, onPlayBest, onRetry }: TriedFactsProps): JSX.Element {
  if (move.verdict) return <MoveFacts move={move.verdict} absPly={absPly} players={players} onPlayBest={onPlayBest} />
  return (
    <div className="review-facts" data-testid="review-tried-pending">
      <div className="review-verdict">
        {move.error ? <Icon name="warning" size={22} /> : <Spinner size={22} />}
        <span className="review-verdict-text">
          {moveNumberPrefix(absPly)}
          {move.san}
        </span>
      </div>
      {move.error ? (
        <div className="row small">
          <span className="review-explain-error grow" role="alert">
            {t('Could not check this move: {error}', { error: move.error })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onRetry(move)} data-testid="review-tried-retry">
            {t('Retry')}
          </button>
        </div>
      ) : (
        <p className="small muted review-start-hint">{t('Stockfish is checking this move…')}</p>
      )}
    </div>
  )
}

function StartFacts({ result, keyCount }: { result: ReviewResult; keyCount: number }): JSX.Element {
  return (
    <div className="review-facts">
      <div className="review-verdict">
        <Icon name="flag" size={22} />
        <span className="review-verdict-text">{t('Starting position')}</span>
      </div>
      <p className="small muted review-start-hint">
        {t('Step through the game with')} <span className="kbd">←</span> <span className="kbd">→</span>
        {t(', click a move, the graph or a count in the summary. {plies} plies, {moments}. You can also play any move on the board to see what Stockfish thinks of it.', {
          plies: result.moves.length,
          moments: tn(keyCount, '{n} key moment', '{n} key moments'),
        })}
      </p>
    </div>
  )
}

/** What the facts need: a graded game move and a graded tried move both have these. */
type GradedMove = Pick<
  ReviewMove,
  | 'san'
  | 'uci'
  | 'fenAfter'
  | 'color'
  | 'evalBefore'
  | 'evalAfter'
  | 'bestMove'
  | 'playedPv'
  | 'winPctBefore'
  | 'winPctAfter'
  | 'classification'
  | 'bookWhy'
  | 'bookOpening'
>

interface MoveFactsProps {
  move: GradedMove
  absPly: number
  players?: Players
  onPlayBest: () => void
}

function MoveFacts({ move, absPly, players, onPlayBest }: MoveFactsProps): JSX.Element {
  const label = `${moveNumberPrefix(absPly)}${move.san}`
  const color = CLASSIFICATION_COLORS[move.classification]
  const differs = move.bestMove.uci !== '' && move.bestMove.uci.slice(0, 4) !== move.uci.slice(0, 4)
  const bestLine = move.bestMove.pv.length > 0 ? move.bestMove.pv : move.bestMove.san ? [move.bestMove.san] : []
  const mover = sideName(players, move.color)
  const before = Math.round(move.winPctBefore)
  const after = Math.round(move.winPctAfter)

  return (
    <div className="review-facts" data-classification={move.classification}>
      <div className="review-verdict" style={{ color }}>
        <ClassificationBadge classification={move.classification} size={26} />
        <span className="review-verdict-text" data-testid="review-verdict">
          {classificationSentence(label, move.classification)}
        </span>
        <span className="spacer" />
        <span className={`review-eval-pill ${scoreSide(move.evalAfter, move.fenAfter)}`} title={t("Evaluation after the move (White's view)")}>
          {formatScore(move.evalAfter)}
        </span>
      </div>

      <div className="review-fact-row">
        <span className="review-fact-key">{t('Eval')}</span>
        <span className="mono review-eval-change" data-testid="review-eval-change">
          {formatScore(move.evalBefore)} <span className="dim">→</span> {formatScore(move.evalAfter)}
        </span>
        <span className="spacer" />
        <span className="small muted" title={t('Win chance for {name} before and after the move', { name: mover })}>
          {mover}: {before}% → <span style={{ color: after < before - 4 ? color : undefined }}>{after}%</span>
        </span>
      </div>

      {differs ? (
        <div className="review-fact-row top">
          <span className="review-fact-key">{t('Best')}</span>
          <div className="grow">
            <span className="review-best-move" data-testid="review-best-move">
              {moveNumberPrefix(absPly)}
              {move.bestMove.san}
            </span>
            {bestLine.length > 1 ? (
              <div className="review-line mono" title={t("Engine's best line")}>
                {formatSanPath(bestLine.slice(0, LINE_PLIES), absPly - 1)}
                {bestLine.length > LINE_PLIES ? ' …' : ''}
              </div>
            ) : null}
          </div>
          <button type="button" className="btn btn-sm btn-primary review-play-best" onClick={onPlayBest} data-testid="review-play-best">
            <Icon name="autoplay" size={14} /> {t('Play best move')}
          </button>
        </div>
      ) : move.classification !== 'book' ? (
        <div className="review-fact-row">
          <span className="review-fact-key">{t('Best')}</span>
          <span className="small muted">
            <Icon name="check" size={13} /> {t("This was the engine's top choice.")}
          </span>
        </div>
      ) : null}

      {move.playedPv.length > 0 ? (
        <div className="review-fact-row top">
          <span className="review-fact-key">{t('Line')}</span>
          <div className="review-line mono grow" title={t('Engine line after {san}', { san: move.san })}>
            {formatSanPath(move.playedPv.slice(0, LINE_PLIES), absPly)}
            {move.playedPv.length > LINE_PLIES ? ' …' : ''}
          </div>
        </div>
      ) : null}

      {move.bookWhy ? (
        <div className="review-book" data-testid="review-book">
          <ClassificationBadge classification="book" size={16} />
          <div>
            {move.bookOpening ? <span className="bold">{move.bookOpening}: </span> : null}
            <span>{move.bookWhy}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** "white" / "black" / "even" for the eval pill colour. */
function scoreSide(score: GradedMove['evalAfter'], fen: string): 'white' | 'black' | 'even' {
  if ('mate' in score) {
    if (score.mate > 0) return 'white'
    if (score.mate < 0) return 'black'
    return (fen.split(' ')[1] ?? 'w') === 'w' ? 'black' : 'white'
  }
  if (score.cp > 20) return 'white'
  if (score.cp < -20) return 'black'
  return 'even'
}

function ExplainPanel(props: ReviewDetailsProps & { move: ReviewMove | null }): JSX.Element {
  const { move, explain, models, modelValue, onModel, effectiveModel, keyPlies, onExplainAll, onJump, result } = props
  const offset = reviewPlyOffset(result)
  const entry = move ? explain.entries[move.ply] : undefined
  const streamingThis = move !== null && explain.streamingPly === move.ply
  const ollamaDown = models.status === 'down'
  const batch = explain.batch
  const remainingKey = keyPlies.filter((p) => explain.entries[p]?.status !== 'done').length
  const err = entry?.status === 'error' && entry.error ? friendlyExplainError(entry.error) : null

  let body: JSX.Element
  if (ollamaDown || err?.kind === 'ollama') {
    body = <ReviewOllamaDown compact onRetry={models.retry} />
  } else if (!move) {
    body = (
      <p className="small muted review-explain-placeholder">
        {t('Pick a move and press')} <b>{t('Explain')}</b>
        {t(', or let the coach go through all {moments}.', { moments: tn(keyPlies.length, '{n} key moment', '{n} key moments') })}
      </p>
    )
  } else if (entry && (entry.text || entry.status === 'streaming')) {
    body = (
      <div className={`review-explain-text${entry.status === 'streaming' ? ' streaming' : ''}`} data-testid="review-explain-text">
        {entry.text}
        {entry.status === 'streaming' ? <span className="review-caret" aria-hidden="true" /> : null}
        {entry.status === 'stopped' ? <span className="dim small"> {t('(stopped)')}</span> : null}
        {err ? <div className="review-explain-error small">{err.text}</div> : null}
      </div>
    )
  } else if (err) {
    body = (
      <div className="review-explain-error small" role="alert" data-testid="review-explain-error">
        <Icon name="warning" size={14} /> {err.text}
      </div>
    )
  } else {
    body = (
      <p className="small muted review-explain-placeholder">
        {t('Ask the coach why {move}.', { move: classificationSentence(move.san, move.classification) })}
      </p>
    )
  }

  return (
    <div className="review-explain" data-testid="review-explain">
      <div className="review-explain-head">
        <Icon name="brain" size={16} />
        <span className="bold">{t('Coach')}</span>
        {entry?.status === 'streaming' ? <Spinner size={12} /> : null}
        <span className="spacer" />
        {!ollamaDown ? <ReviewModelPicker models={models} value={modelValue} onChange={onModel} compact /> : null}
      </div>
      <div className="review-explain-body" aria-live="polite">
        {body}
      </div>
      <div className="review-explain-actions">
        {streamingThis && !batch ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={explain.stop} data-testid="review-explain-stop">
            <Icon name="pause" size={14} /> {t('Stop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!move || ollamaDown || models.status === 'loading'}
            onClick={() => move && explain.explain(move.ply)}
            data-testid="review-explain-btn"
            title={effectiveModel ? t('Explain with {model}', { model: effectiveModel }) : t('Explain with the backend default model')}
          >
            <Icon name="brain" size={14} /> {entry?.status === 'done' ? t('Explain again') : t('Explain')}
          </button>
        )}
        {batch ? (
          <>
            <button type="button" className="btn btn-sm btn-danger" onClick={explain.stop} data-testid="review-explain-all-stop">
              <Icon name="pause" size={14} /> {t('Stop')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm review-batch-status"
              onClick={() => batch.current !== null && onJump(batch.current)}
              title={t('Show the move being explained')}
              data-testid="review-batch-status"
            >
              <Spinner size={12} /> {batch.index + 1} / {batch.plies.length}
              {batch.current !== null && result.moves[batch.current - 1]
                ? ` · ${moveNumberPrefix(offset + batch.current)}${result.moves[batch.current - 1].san}`
                : ''}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={ollamaDown || remainingKey === 0 || models.status === 'loading'}
            onClick={onExplainAll}
            data-testid="review-explain-all"
            title={
              keyPlies.length === 0
                ? t('No key moments in this game')
                : t('Explain every blunder, mistake, miss, inaccuracy, brilliant and great move, one after another')
            }
          >
            <Icon name="autoplay" size={14} />{' '}
            {keyPlies.length > 0 && remainingKey === 0
              ? t('All key moments explained')
              : t('Explain all key moments ({count})', { count: remainingKey })}
          </button>
        )}
      </div>
    </div>
  )
}
