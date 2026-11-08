import type { JSX } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { botName, botTitle, currentElo, outcomeFor, reasonText, type PlayGame } from './PlayGame'

export interface PlayGameOverModalProps {
  open: boolean
  game: PlayGame | null
  onClose: () => void
  onReview: () => void
  onRematch: () => void
  onNewGame: () => void
}

/** Result dialog: who won and how, plus Review this game / Rematch / New game. */
export function PlayGameOverModal({ open, game, onClose, onReview, onRematch, onNewGame }: PlayGameOverModalProps): JSX.Element | null {
  if (!game || !game.result) return null
  const outcome = outcomeFor(game)
  const title = outcome === 'win' ? 'You won!' : outcome === 'loss' ? `${botName(game.bot, game.variant)} won` : 'Draw'
  const moves = Math.ceil(game.sans.length / 2)
  const o = game.opening
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Game over"
      width={500}
      className="play-over-modal"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onNewGame} data-testid="play-over-new">
            <Icon name="plus" size={16} /> New game
          </button>
          <button type="button" className="btn" onClick={onRematch} data-testid="play-over-rematch">
            <Icon name="refresh" size={16} /> Rematch
          </button>
          {game.variant === 'standard' ? (
            <button type="button" className="btn btn-primary" onClick={onReview} data-testid="play-over-review">
              <Icon name="review" size={16} /> Review this game
            </button>
          ) : null}
        </>
      }
    >
      <div className={`play-over ${outcome ?? ''}`} data-testid="play-over">
        <div className="play-over-icon">
          <Icon name={outcome === 'win' ? 'star' : outcome === 'loss' ? 'flag' : 'swords'} size={30} />
        </div>
        <div className="play-over-title">{title}</div>
        <div className="play-over-reason">{reasonText(game.result.reason)}</div>
        <div className="play-over-score mono">{game.result.result}</div>
        <div className="play-over-meta">
          <span>
            You played {game.studentColor} vs {botTitle(game.bot, currentElo(game), game.variant)}
          </span>
          <span>
            {moves} move{moves === 1 ? '' : 's'}
          </span>
          {o ? (
            <span>
              {o.name}: {o.lineName}
              {o.mode === 'hints' ? ` (book moves ${game.bookStats.correct} correct, ${game.bookStats.missed} missed)` : ''}
            </span>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
