/**
 * Coach card under the Learn board: for the student's last move and the opponent's reply (or an
 * off-book move), the move, its classification badge, the engine eval after it, the repertoire
 * note (instant, from the tree) and the coach's explanation (streamed from /ws/coach).
 * Also hosts the "Play opponent's move" prompt, the off-book actions and the "Line complete"
 * summary. Keeps `data-testid="learn-why"` (the old why box) so the repertoire note stays findable.
 *
 * On short screens the opponent's row of a pair can sit entirely below the fold of the card: a
 * bar pinned to the bottom of the card then shows that row's move, badge and eval, and scrolls
 * to it on click.
 */
import { useCallback, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type Ref } from 'react'
import type { Classification, OpeningNode, Score } from '../../api/types'
import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS, ClassificationBadge } from '../../components/ClassificationBadge'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import { formatScore } from '../../lib/eval'
import {
  learnCleanCoachText,
  learnEngineTag,
  learnIsSoundMove,
  learnVerdictSentence,
  type LearnCoachItem,
  type LearnCoachRow,
} from './learnCoach'
import { learnMoveLabel, learnNagClass } from './learnUtils'
import type { LearnCoachEntry } from './useLearnCoach'
import type { LearnLineComplete } from './useLearnPractice'

export interface LearnCoachOffBook {
  /** The repertoire move the student should have played (drawn as a green arrow), if any. */
  repertoire: OpeningNode | null
  onTakeBack: () => void
  onAnalyze: () => void
}

export interface LearnCoachCardProps {
  rows: readonly LearnCoachRow[]
  entry: (item: LearnCoachItem) => LearnCoachEntry | undefined
  /** "Ask the coach" / retry for one row. */
  onAsk: (row: LearnCoachRow) => void
  /** Set when rows[0] is an off-book move on the board. */
  offBook: LearnCoachOffBook | null
  complete: LearnLineComplete | null
  onPracticeAgain: () => void
  onNextLine: () => void
  /** Show the "Play opponent's move" prompt. */
  canPlayOpponent: boolean
  onPlayOpponent: () => void
  /** Shown instead of the rows at the starting position. */
  placeholder?: ReactNode
  /** Extra note at the bottom (end of line while browsing). */
  footer?: ReactNode
}

export function LearnCoachCard(props: LearnCoachCardProps): JSX.Element {
  // a new pair (new first move) starts scrolled to the top
  const pairKey = props.rows[0]?.nodeId ?? 'start'
  return <CoachCardBody key={pairKey} {...props} />
}

function CoachCardBody(props: LearnCoachCardProps): JSX.Element {
  const { rows, entry, onAsk, offBook, complete, canPlayOpponent, onPlayOpponent, placeholder, footer } = props
  const cardRef = useRef<HTMLDivElement>(null)
  const replyRef = useRef<HTMLDivElement>(null)
  /** The second row of the pair (the opponent's reply) is entirely below the visible part of the card. */
  const [replyHidden, setReplyHidden] = useState(false)
  const reply = rows.length > 1 ? rows[rows.length - 1] : null
  const replyEntry = reply ? entry(reply.item) : undefined

  const measure = useCallback(() => {
    const card = cardRef.current
    const row = replyRef.current
    if (!card || !row) {
      setReplyHidden(false)
      return
    }
    const c = card.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    // hidden when even the row's head (about 24 px) is not visible above the card's bottom edge
    setReplyHidden(r.top > c.bottom - 24)
  }, [])

  useLayoutEffect(() => {
    measure()
    const card = cardRef.current
    if (!card) return
    card.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(card)
    const rowsEl = card.querySelector('.learn-coach-rows')
    if (rowsEl) ro?.observe(rowsEl)
    return () => {
      card.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [measure, reply?.nodeId])

  const showReply = useCallback(() => {
    const card = cardRef.current
    const row = replyRef.current
    if (!card || !row) return
    const top = card.scrollTop + row.getBoundingClientRect().top - card.getBoundingClientRect().top - 6
    card.scrollTo({ top, behavior: 'smooth' })
  }, [])

  return (
    <div className="learn-coach" data-testid="learn-why" ref={cardRef}>
      {canPlayOpponent ? (
        <div className="learn-coach-turn">
          <Icon name="robot" size={15} />
          <span className="muted">Opponent to move.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onPlayOpponent} data-testid="learn-play-opponent">
            <Icon name="autoplay" size={14} /> Play opponent's move <span className="kbd learn-kbd">Space</span>
          </button>
        </div>
      ) : null}

      {complete ? <CompleteBanner complete={complete} onAgain={props.onPracticeAgain} onNext={props.onNextLine} /> : null}

      {rows.length === 0 ? (
        placeholder
      ) : (
        <div className={`learn-coach-rows${rows.length > 1 ? ' pair' : ''}`}>
          {rows.map((r) => (
            <CoachRow
              key={r.nodeId}
              row={r}
              entry={entry(r.item)}
              onAsk={onAsk}
              offBook={!r.inBook ? offBook : null}
              rowRef={r === reply ? replyRef : undefined}
            />
          ))}
        </div>
      )}
      {footer}
      {reply && replyHidden ? <ReplyBar row={reply} entry={replyEntry} onClick={showReply} /> : null}
    </div>
  )
}

/** Pinned to the bottom of the card while the opponent's row is below the fold. */
function ReplyBar({ row, entry, onClick }: { row: LearnCoachRow; entry: LearnCoachEntry | undefined; onClick: () => void }): JSX.Element {
  const v = entry?.verdict ?? null
  const cls: Classification | null = row.inBook ? 'book' : (v?.classification ?? null)
  const textState = entry?.textState ?? 'idle'
  const note =
    textState === 'streaming' || textState === 'queued'
      ? 'coach is explaining…'
      : textState === 'done'
        ? "read the coach's explanation"
        : row.why
          ? 'see the repertoire note'
          : 'see below'
  return (
    <button type="button" className="learn-coach-more" onClick={onClick} data-testid="learn-coach-more" title="Scroll to the opponent's reply">
      <Icon name="next" size={13} className="learn-coach-more-icon" />
      <span className="learn-coach-who opp">{row.isStudent ? 'You' : 'Opponent'}</span>
      <span className="learn-coach-move">{row.label}</span>
      {cls ? <ClassificationBadge classification={cls} size={15} withLabel className="learn-coach-badge" /> : null}
      {v ? <span className={`learn-coach-eval ${evalSide(v.evalAfter, v.fenAfter)}`}>{formatScore(v.evalAfter)}</span> : null}
      <span className="dim truncate learn-coach-more-note">{note}</span>
    </button>
  )
}

function CompleteBanner({ complete, onAgain, onNext }: { complete: LearnLineComplete; onAgain: () => void; onNext: () => void }): JSX.Element {
  const { moves, offBook } = complete
  return (
    <div className="learn-complete" data-testid="learn-complete">
      <div className="learn-complete-head">
        <Icon name="check" size={16} />
        <b>Line complete</b>
        <span className="truncate learn-complete-name" title={complete.lineName}>
          {complete.lineName}
        </span>
      </div>
      <div className="learn-complete-stats">
        <span data-testid="learn-complete-moves">
          <b>{moves}</b> move{moves === 1 ? '' : 's'} played
        </span>
        <span className="dim">·</span>
        <span data-testid="learn-complete-offbook" className={offBook > 0 ? 'learn-complete-warn' : ''}>
          <b>{offBook}</b> off-book attempt{offBook === 1 ? '' : 's'}
        </span>
        <span className="learn-complete-actions">
          <button type="button" className="btn btn-sm" onClick={onAgain} data-testid="learn-practice-again">
            <Icon name="refresh" size={14} /> Practice again
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onNext} data-testid="learn-next-line">
            <Icon name="next" size={14} /> Next line
          </button>
        </span>
      </div>
      {complete.evaluation ? <div className="learn-complete-eval muted">{complete.evaluation}</div> : null}
    </div>
  )
}

function evalSide(score: Score, fen: string): 'white' | 'black' | 'even' {
  if ('mate' in score) {
    if (score.mate > 0) return 'white'
    if (score.mate < 0) return 'black'
    return (fen.split(' ')[1] ?? 'w') === 'w' ? 'black' : 'white'
  }
  if (score.cp > 20) return 'white'
  if (score.cp < -20) return 'black'
  return 'even'
}

interface CoachRowProps {
  row: LearnCoachRow
  entry: LearnCoachEntry | undefined
  onAsk: (row: LearnCoachRow) => void
  offBook: LearnCoachOffBook | null
  rowRef?: Ref<HTMLDivElement>
}

function CoachRow({ row, entry, onAsk, offBook, rowRef }: CoachRowProps): JSX.Element {
  const v = entry?.verdict ?? null
  const cls: Classification | null = row.inBook ? 'book' : (v?.classification ?? null)
  const tag = row.inBook && v ? learnEngineTag(v) : null
  const verdictState = entry?.verdictState ?? 'idle'
  return (
    <div
      ref={rowRef}
      className={`learn-coach-row ${row.isStudent ? 'student' : 'opponent'}${row.inBook ? '' : ' offbook'}`}
      data-testid="learn-coach-row"
      data-node-id={row.nodeId}
      data-classification={cls ?? ''}
      data-verdict={verdictState}
      data-text={entry?.textState ?? 'idle'}
    >
      <div className="learn-coach-head">
        <span className={`learn-coach-who ${row.isStudent ? 'you' : 'opp'}`}>{row.isStudent ? 'You' : 'Opponent'}</span>
        <span className="learn-coach-move">
          {row.label}
          {row.nag ? <span className={`nag ${learnNagClass(row.nag)}`}>{row.nag}</span> : null}
        </span>
        {cls ? (
          <ClassificationBadge classification={cls} size={17} withLabel className="learn-coach-badge" />
        ) : verdictState === 'pending' ? (
          <Spinner size={12} />
        ) : null}
        {tag ? (
          <span className="learn-coach-tag" style={{ color: CLASSIFICATION_COLORS[tag] }} title="The engine's verdict, ignoring opening theory">
            engine: {CLASSIFICATION_LABELS[tag].toLowerCase()}
          </span>
        ) : null}
        <span className="spacer" />
        {v ? (
          <span
            className={`learn-coach-eval ${evalSide(v.evalAfter, v.fenAfter)}`}
            title="Engine evaluation after the move (White's view)"
            data-testid="learn-coach-eval"
          >
            {formatScore(v.evalAfter)}
          </span>
        ) : verdictState === 'pending' && cls ? (
          <Spinner size={12} />
        ) : null}
      </div>

      {offBook ? <OffBookVerdict row={row} entry={entry} offBook={offBook} /> : null}
      {row.why ? <p className="learn-coach-why">{row.why}</p> : null}
      <CoachText row={row} entry={entry} onAsk={onAsk} />
    </div>
  )
}

function OffBookVerdict({ row, entry, offBook }: { row: LearnCoachRow; entry: LearnCoachEntry | undefined; offBook: LearnCoachOffBook }): JSX.Element {
  const v = entry?.verdict ?? null
  const rep = offBook.repertoire
  let verdict: ReactNode
  if (v) {
    verdict = learnIsSoundMove(v.classification) ? (
      <b className="learn-offbook-ok">Good move, but not in this repertoire.</b>
    ) : (
      <b style={{ color: CLASSIFICATION_COLORS[v.classification] }}>{learnVerdictSentence(row.label, v.classification)}.</b>
    )
  } else if (entry?.verdictState === 'pending') {
    verdict = (
      <span className="muted">
        {row.label} is not in this repertoire. Checking it with the engine… <Spinner size={11} />
      </span>
    )
  } else {
    verdict = <b className="learn-offbook-warn">{row.label} is not in this repertoire.</b>
  }
  return (
    <div className="learn-offbook" data-testid="learn-offbook">
      <div className="learn-offbook-verdict" data-testid="learn-offbook-verdict">
        {verdict}
      </div>
      {rep ? (
        <div className="learn-offbook-rep">
          <span className="learn-offbook-rep-label">Repertoire:</span> <b>{learnMoveLabel(rep)}</b>
          {rep.why ? <span className="muted"> {rep.why}</span> : null}
        </div>
      ) : (
        <div className="learn-offbook-rep muted">The repertoire has no move here.</div>
      )}
      <div className="learn-offbook-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={offBook.onTakeBack} data-testid="learn-takeback" title="Take back (Backspace, Esc or Left arrow)">
          <Icon name="undo" size={14} /> Take back
        </button>
        <button type="button" className="btn btn-sm" onClick={offBook.onAnalyze} data-testid="learn-offbook-analyze">
          <Icon name="analyze" size={14} /> Analyze it
        </button>
      </div>
    </div>
  )
}

const AI_NOTE =
  'Explanation written by a local AI model (Ollama): it can get details wrong. The badge and the evaluation come from Stockfish.'

function CoachText({ row, entry, onAsk }: { row: LearnCoachRow; entry: LearnCoachEntry | undefined; onAsk: (row: LearnCoachRow) => void }): JSX.Element {
  const state = entry?.textState ?? 'idle'
  if (state === 'done' || state === 'streaming') {
    return (
      <div
        className={`learn-coach-text${state === 'streaming' ? ' streaming' : ''}`}
        data-testid="learn-coach-text"
        aria-live="polite"
        title={AI_NOTE}
      >
        <Icon name="brain" size={14} className="learn-coach-icon" />
        <span>
          {learnCleanCoachText(entry?.text ?? '')}
          {state === 'streaming' ? <span className="learn-caret" aria-hidden="true" /> : null}
        </span>
      </div>
    )
  }
  if (state === 'queued') {
    return (
      <div className="learn-coach-text pending" data-testid="learn-coach-text">
        <Icon name="brain" size={14} className="learn-coach-icon" />
        <span className="dim">
          Coach is thinking… <Spinner size={11} />
        </span>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className="learn-coach-text error" data-testid="learn-coach-error" role="status">
        <Icon name="warning" size={14} className="learn-coach-icon" />
        <span>
          {entry?.textError ?? 'Coach unavailable.'}{' '}
          <button type="button" className="learn-link" onClick={() => onAsk(row)}>
            Retry
          </button>
        </span>
      </div>
    )
  }
  // idle: nothing asked yet (browsing, or auto-explain off)
  return (
    <div className="learn-coach-text idle">
      {entry?.verdictState === 'error' ? <span className="dim learn-coach-err-inline">{entry.verdictError} </span> : null}
      <button type="button" className="learn-link learn-ask" onClick={() => onAsk(row)} data-testid="learn-ask-coach">
        <Icon name="brain" size={13} /> Ask the coach
      </button>
    </div>
  )
}
