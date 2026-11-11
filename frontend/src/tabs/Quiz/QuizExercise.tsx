/**
 * One exercise: the board column (board, status line, action buttons) and the exercise panel in
 * the side column. Render it with `key={task.key}` so every task starts from a fresh state.
 */
import { useEffect, useMemo, type CSSProperties, type JSX, type ReactNode } from 'react'
import { Board, type BoardShape } from '../../components/Board'
import { Icon } from '../../components/Icon'
import { LINE_CATEGORY_LABELS } from '../../api/types'
import { moveNumberPrefix, parseUci, type Square } from '../../lib/chess'
import { t, tn } from '../../lib/i18n'
import { studentPlies, type ExpectedMove, type QuizTask } from './QuizTasks'
import { useQuizRunner, type Feedback, type PlayedMove, type RunnerState } from './useQuizRunner'

export interface QuizExerciseProps {
  task: QuizTask
  coordinates: boolean
  onResult: (task: QuizTask, nodeId: string, correct: boolean) => void
  onNext: () => void
  onRestart: () => void
  onOpenLearn: (task: QuizTask, sans: string[]) => void
  /** Panels above / below the exercise panel in the side column. */
  sideTop?: ReactNode
  sideBottom?: ReactNode
}

const SIDE_LABEL = { white: t('White'), black: t('Black') } as const

function arrow(uci: string, brush: BoardShape['brush']): BoardShape | null {
  if (!uci || uci.length < 4) return null
  const { from, to } = parseUci(uci)
  return { orig: from as Square, dest: to as Square, brush }
}

function moveLabel(index: number, san: string): string {
  return `${moveNumberPrefix(index + 1)}${san}`
}

export function QuizExercise({ task, coordinates, onResult, onNext, onRestart, onOpenLearn, sideTop, sideBottom }: QuizExerciseProps): JSX.Element {
  const runner = useQuizRunner(task, onResult)
  const { state, turn, expected, onMove, giveUp, playRevealed, shake } = runner
  const sequence = task.mode !== 'positions'

  // Enter = next (when done) / play the revealed move (when shown)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (turn === 'done') {
        e.preventDefault()
        onNext()
      } else if (turn === 'student' && state.revealed && sequence) {
        e.preventDefault()
        playRevealed()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turn, state.revealed, sequence, onNext, playRevealed])

  const shapes = useMemo(() => {
    const out: BoardShape[] = []
    if (state.revealed) {
      state.revealed.forEach((m, i) => {
        const a = arrow(m.uci, i === 0 ? 'green' : 'paleGreen')
        if (a) out.push(a)
      })
      if (state.wrongUci) {
        const a = arrow(state.wrongUci, 'red')
        if (a) out.push(a)
      }
    }
    return out
  }, [state.revealed, state.wrongUci])

  const studentTurns = task.line ? studentPlies(task.line, task.side).length : 0
  const studentDone = state.played.filter((p) => p.by === 'student').length
  const firstResult = state.played.find((p) => p.by === 'student')?.mark ?? (state.forcedDone ? 'mistake' : undefined)

  return (
    <>
      <div className="workspace-board quiz-board-col" style={{ '--below-board-h': '112px' } as CSSProperties}>
        <div className="board-frame">
          <Board
            fen={state.fen}
            orientation={task.side}
            lastMove={state.lastUci}
            interactive={turn === 'student'}
            movableColor={turn === 'student' ? task.side : 'none'}
            onMove={onMove}
            shapes={shapes}
            coordinates={coordinates}
            shake={shake}
          />
        </div>
        <QuizStatusBar
          task={task}
          state={state}
          turn={turn}
          firstResult={firstResult}
          onGiveUp={giveUp}
          onPlayRevealed={playRevealed}
          onNext={onNext}
          onRestart={onRestart}
          onOpenLearn={() => onOpenLearn(task, state.sans)}
          canGiveUp={turn === 'student' && !state.revealed && expected.length > 0}
        />
      </div>
      <div className="workspace-side">
        {sideTop}
        <div className="panel grow quiz-exercise" data-testid="quiz-exercise" data-turn={turn} data-item-id={task.item?.id}>
          <div className="panel-header">
            <Icon name={task.mode === 'line' ? 'learn' : task.mode === 'traps' ? 'target' : 'quiz'} size={18} />
            <span className="panel-title truncate" title={exerciseTitle(task)}>
              {exerciseTitle(task)}
            </span>
            <span className={`badge badge-${task.side}`}>{SIDE_LABEL[task.side]}</span>
          </div>
          <div className="panel-body scroll quiz-exercise-body">
            {turn === 'done' && task.mode !== 'positions' ? (
              <QuizSummary task={task} state={state} studentTurns={studentTurns} firstResult={firstResult} onNext={onNext} onRestart={onRestart} />
            ) : null}
            <div className="quiz-meta muted small">
              <span className="truncate">{task.openingName}</span>
              {task.line ? <span className="badge">{LINE_CATEGORY_LABELS[task.line.category]}</span> : null}
              {task.mode === 'traps' && task.item ? (
                <span className="badge badge-red">{t('Trap')}</span>
              ) : null}
            </div>
            {task.line ? (
              <div className="quiz-progress-row">
                <div className="progress" aria-label={t('Line progress')}>
                  <span style={{ width: `${studentTurns ? (studentDone / studentTurns) * 100 : 0}%` }} />
                </div>
                <span className="small muted nowrap">
                  {t('{done}/{total} moves', { done: studentDone, total: studentTurns })}
                </span>
              </div>
            ) : null}

            <QuizMoveText task={task} played={state.played} sans={state.sans} />

            {task.item?.lastOpponentMove && state.played.length === 0 ? (
              <div className="quiz-note">
                <div className="quiz-note-title">
                  {t('Opponent played')} <span className="move-san">{moveLabel(task.startSans.length - 1, task.item.lastOpponentMove.san)}</span>
                </div>
                {task.item.lastOpponentMove.why ? <p className="muted">{task.item.lastOpponentMove.why}</p> : null}
              </div>
            ) : null}

            {state.feedback ? <QuizFeedbackCard feedback={state.feedback} task={task} sans={state.sans} /> : null}

            <QuizOpponentNote played={state.played} turn={turn} />

            {turn === 'done' && task.mode === 'positions' ? (
              <QuizSummary task={task} state={state} studentTurns={studentTurns} firstResult={firstResult} onNext={onNext} onRestart={onRestart} />
            ) : null}
          </div>
        </div>
        {sideBottom}
      </div>
    </>
  )
}

function exerciseTitle(task: QuizTask): string {
  if (task.mode === 'line') return task.line?.name ?? t('Line drill')
  if (task.mode === 'traps') return task.trapLines?.[0]?.name ?? task.item?.answers[0]?.lineNames[0] ?? t('Trap')
  return t('Find the book move')
}

// ---------------------------------------------------------------- status bar under the board

interface StatusBarProps {
  task: QuizTask
  state: RunnerState
  turn: 'student' | 'opponent' | 'done'
  firstResult: string | undefined
  canGiveUp: boolean
  onGiveUp: () => void
  onPlayRevealed: () => void
  onNext: () => void
  onRestart: () => void
  onOpenLearn: () => void
}

function QuizStatusBar({ task, state, turn, firstResult, canGiveUp, onGiveUp, onPlayRevealed, onNext, onRestart, onOpenLearn }: StatusBarProps): JSX.Element {
  const side = SIDE_LABEL[task.side]
  let tone: 'neutral' | 'good' | 'bad' | 'info' = 'neutral'
  let title: string
  let sub = ''
  if (turn === 'done') {
    if (task.mode === 'positions') {
      tone = firstResult === 'clean' ? 'good' : 'bad'
      title = firstResult === 'clean' ? t('Correct!') : t('Not quite')
      sub = firstResult === 'clean' ? t('That is a book move.') : t('The book move is shown with a green arrow.')
    } else {
      tone = state.mistakes === 0 ? 'good' : 'neutral'
      title = task.mode === 'line' ? t('Line complete') : t('Trap complete')
      sub = state.mistakes === 0 ? (state.retries === 0 ? t('Flawless.') : t('No mistakes.')) : tn(state.mistakes, '{n} mistake.', '{n} mistakes.')
    }
  } else if (turn === 'opponent') {
    title = t('Opponent is replying...')
  } else if (state.revealed) {
    tone = 'bad'
    title = state.revealed.length > 1 ? t('Play one of the shown moves') : t('Play {move}', { move: state.revealed[0]?.san ?? t('the shown move') })
    sub = t('Marked as a mistake. Press Enter to play it.')
  } else if (state.feedback?.tone === 'bad') {
    tone = 'bad'
    title = t('Try again')
    sub = t('{san} is not the move.', { san: state.feedback.san })
  } else if (state.feedback?.tone === 'info') {
    tone = 'info'
    title = t('Also book, but not this line')
    sub = t('Try the move of the line you are drilling.')
  } else if (state.feedback?.tone === 'good') {
    tone = 'good'
    title = t('Correct!')
    sub = t('Your move ({side}).', { side })
  } else {
    title = t('Your move')
    sub =
      task.mode === 'line'
        ? t("Play {side}'s move from the line.", { side })
        : task.mode === 'traps'
          ? t('The opponent just went wrong. Punish it.')
          : t('Find a book move for {side}.', { side })
  }

  return (
    <div className={`quiz-status quiz-status-${tone}`} data-testid="quiz-status">
      <div className="quiz-status-text">
        <div className="quiz-status-title">
          {tone === 'good' ? <Icon name="check" size={20} /> : tone === 'bad' ? <Icon name="close" size={20} /> : null}
          <span>{title}</span>
        </div>
        {sub ? <div className="quiz-status-sub muted">{sub}</div> : null}
      </div>
      <div className="quiz-status-actions">
        {task.mode === 'line' ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart} title={t('Restart this line')}>
            <Icon name="refresh" size={16} /> {t('Restart')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLearn} title={t('Open this position in Learn')}>
          <Icon name="learn" size={16} /> {t('Learn')}
        </button>
        {canGiveUp ? (
          <button type="button" className="btn btn-sm" onClick={onGiveUp} title={t('Reveal the move (counts as a mistake)')}>
            <Icon name="hint" size={16} /> {t('Show move')}
          </button>
        ) : null}
        {turn === 'student' && state.revealed && task.mode !== 'positions' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onPlayRevealed} data-testid="quiz-play-revealed">
            {t('Play it')} <span className="kbd">Enter</span>
          </button>
        ) : null}
        {turn === 'done' ? (
          <button type="button" className="btn btn-primary" onClick={onNext} data-testid="quiz-next">
            {task.mode === 'line' ? t('Next line') : t('Next')} <span className="kbd">Enter</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- side panel pieces

function QuizMoveText({ task, played, sans }: { task: QuizTask; played: PlayedMove[]; sans: string[] }): JSX.Element | null {
  if (sans.length === 0) return <div className="quiz-moves muted small">{t('Starting position')}</div>
  const marks = new Map(played.map((p) => [p.index, p]))
  const startCount = task.startSans.length
  return (
    <div className="quiz-moves" data-testid="quiz-moves">
      {sans.map((san, i) => {
        const p = marks.get(i)
        const white = i % 2 === 0
        const cls = [
          'quiz-move',
          i < startCount ? 'quiz-move-pre' : '',
          p?.mark ? `quiz-move-${p.mark}` : '',
          i === sans.length - 1 ? 'quiz-move-last' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <span key={i} className={cls}>
            {white ? <span className="quiz-move-no">{i / 2 + 1}.</span> : i === 0 ? <span className="quiz-move-no">1...</span> : null}
            {san}
          </span>
        )
      })}
    </div>
  )
}

function lineList(names: string[]): JSX.Element | null {
  if (names.length === 0) return null
  const shown = names.slice(0, 4)
  return (
    <div className="quiz-lines small">
      <span className="dim">{names.length === 1 ? t('Line:') : t('Lines:')}</span>{' '}
      {shown.map((n, i) => (
        <span key={n + i} className="quiz-line-name">
          {n}
        </span>
      ))}
      {names.length > shown.length ? <span className="dim"> {t('+{count} more', { count: names.length - shown.length })}</span> : null}
    </div>
  )
}

function ExpectedBlock({ move, index }: { move: ExpectedMove; index: number }): JSX.Element {
  return (
    <div className="quiz-answer">
      <div className="quiz-answer-san move-san">{moveLabel(index, move.san)}</div>
      {move.why ? <p>{move.why}</p> : <p className="dim">{t('No explanation in the data for this move.')}</p>}
      {lineList(move.lineNames)}
    </div>
  )
}

function QuizFeedbackCard({ feedback, task, sans }: { feedback: Feedback; task: QuizTask; sans: string[] }): JSX.Element {
  switch (feedback.tone) {
    case 'good': {
      const index = sans.length - 1
      return (
        <div className="quiz-feedback quiz-feedback-good fade-in" data-testid="quiz-feedback" data-tone="good">
          <div className="quiz-feedback-title">
            <Icon name="check" size={16} /> {feedback.afterRetry ? t('Right, on the second try') : t('Correct')}:{' '}
            <span className="move-san">{moveLabel(index, feedback.san)}</span>
          </div>
          {feedback.why ? <p>{feedback.why}</p> : null}
          {task.mode !== 'line' ? lineList(feedback.lineNames) : null}
          {feedback.others.length > 0 ? (
            <div className="quiz-others small">
              <span className="dim">{t('Also in the book:')}</span>{' '}
              {feedback.others.map((o) => (
                <span key={o.san} className="quiz-other" title={o.lineNames.join(', ')}>
                  {o.san}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )
    }
    case 'bad':
      return (
        <div className="quiz-feedback quiz-feedback-bad fade-in" data-testid="quiz-feedback" data-tone="bad">
          <div className="quiz-feedback-title">
            <Icon name="close" size={16} /> {t('{san} is not the move. Try again.', { san: feedback.san })}
          </div>
          <p className="muted small">
            {feedback.triesLeft === 1 ? t('One more wrong try and the answer is shown.') : tn(feedback.triesLeft, '{n} try left.', '{n} tries left.')}
          </p>
        </div>
      )
    case 'info':
      return (
        <div className="quiz-feedback quiz-feedback-info fade-in" data-testid="quiz-feedback" data-tone="info">
          <div className="quiz-feedback-title">
            <Icon name="info" size={16} /> {t('{san} is in your repertoire too', { san: feedback.san })}
          </div>
          <p className="muted small">
            {feedback.lineNames.length ? t('It belongs to {lines}.', { lines: feedback.lineNames.slice(0, 2).join(', ') }) + ' ' : ''}
            {t('This drill follows "{line}". Not counted as a mistake.', { line: task.line?.name ?? '' })}
          </p>
        </div>
      )
    case 'reveal':
      return (
        <div className="quiz-feedback quiz-feedback-reveal fade-in" data-testid="quiz-feedback" data-tone="reveal">
          <div className="quiz-feedback-title">
            <Icon name="hint" size={16} />
            {feedback.wrongSan ? ` ${t('{san} is wrong.', { san: feedback.wrongSan })} ` : ' '}
            {feedback.moves.length > 1 ? t('The book moves were:') : t('The move was:')}
          </div>
          {feedback.moves.map((m) => (
            <ExpectedBlock key={m.san} move={m} index={sans.length} />
          ))}
        </div>
      )
    case 'follow':
      return (
        <div className="quiz-feedback quiz-feedback-follow fade-in" data-testid="quiz-feedback" data-tone="follow">
          <div className="quiz-feedback-title">
            {t('Played')} <span className="move-san">{moveLabel(sans.length - 1, feedback.san)}</span> {t('(marked as a mistake)')}
          </div>
        </div>
      )
  }
}

function QuizOpponentNote({ played, turn }: { played: PlayedMove[]; turn: string }): JSX.Element | null {
  const last = played[played.length - 1]
  if (!last || last.by !== 'opponent' || !last.why) return null
  return (
    <div className={`quiz-note fade-in${turn === 'done' ? ' quiz-note-dim' : ''}`} data-testid="quiz-opponent-note">
      <div className="quiz-note-title">
        {t('Opponent:')} <span className="move-san">{moveLabel(last.index, last.san)}</span>
      </div>
      <p className="muted">{last.why}</p>
    </div>
  )
}

function QuizSummary({
  task,
  state,
  studentTurns,
  firstResult,
  onNext,
  onRestart,
}: {
  task: QuizTask
  state: RunnerState
  studentTurns: number
  firstResult: string | undefined
  onNext: () => void
  onRestart: () => void
}): JSX.Element {
  if (task.mode === 'positions') {
    return (
      <div className="quiz-summary" data-testid="quiz-summary">
        <div className="row">
          <span className={`badge ${firstResult === 'clean' ? 'badge-green' : 'badge-red'}`}>{firstResult === 'clean' ? t('Correct') : t('Missed')}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" onClick={onNext}>
            {t('Next')} <span className="kbd">Enter</span>
          </button>
        </div>
      </div>
    )
  }
  const turns = state.played.filter((p) => p.by === 'student').length
  return (
    <div className="quiz-summary fade-in" data-testid="quiz-summary">
      <h3>{task.mode === 'line' ? t('Line complete') : t('Trap complete')}</h3>
      {task.mode === 'line' && task.line?.evaluation ? <p className="muted small">{task.line.evaluation}</p> : null}
      <div className="quiz-summary-grid">
        <div>
          <div className="quiz-summary-num" data-testid="quiz-summary-mistakes">{state.mistakes}</div>
          <div className="dim small">{t('mistakes')}</div>
        </div>
        <div>
          <div className="quiz-summary-num">{state.retries}</div>
          <div className="dim small">{t('second tries')}</div>
        </div>
        <div>
          <div className="quiz-summary-num">
            {state.clean}/{task.mode === 'line' ? studentTurns : turns}
          </div>
          <div className="dim small">{t('first-try moves')}</div>
        </div>
      </div>
      <div className="row mt-8">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart}>
          <Icon name="refresh" size={16} /> {task.mode === 'line' ? t('Retry line') : t('Retry')}
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={onNext}>
          {task.mode === 'line' ? t('Next line') : t('Next trap')} <span className="kbd">Enter</span>
        </button>
      </div>
    </div>
  )
}
