/** History tab: every finished Play game, with the bot, its Elo and (once reviewed) the accuracy. */
import { useState, type JSX } from 'react'
import type { BotKind, Side } from '../../api/types'
import { EmptyState } from '../../components/EmptyState'
import { Icon, type IconName } from '../../components/Icon'
import { loadHistory, type HistoryGame } from '../../lib/gameHistory'
import { variantInfo } from '../../lib/variants'
import { useApp } from '../../state/AppContext'
import { botName } from '../Play/PlayGame'
import { formatAccuracy } from '../Review/reviewUtils'
import './HistoryTab.css'

const BOT_ICONS: Record<BotKind, IconName> = { stockfish: 'engine', maia: 'brain', panicfish: 'fish' }

const SCORES: Record<string, readonly [string, string]> = {
  '1-0': ['1', '0'],
  '0-1': ['0', '1'],
  '1/2-1/2': ['½', '½'],
}

const OUTCOMES = {
  win: { mark: '+', label: 'You won' },
  loss: { mark: '−', label: 'You lost' },
  draw: { mark: '=', label: 'Draw' },
} as const

function outcomeOf(game: HistoryGame): keyof typeof OUTCOMES | null {
  if (game.result === '1/2-1/2') return 'draw'
  if (game.result !== '1-0' && game.result !== '0-1') return null
  return (game.result === '1-0') === (game.studentColor === 'white') ? 'win' : 'loss'
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function Player({ game, side }: { game: HistoryGame; side: Side }): JSX.Element {
  const isStudent = side === game.studentColor
  return (
    <div className="history-player">
      <span className={`history-side ${side}`} />
      <span className="history-name">{isStudent ? 'You' : botName(game.bot, game.variant)}</span>
      {isStudent ? null : <span className="history-elo">({game.elo})</span>}
    </div>
  )
}

function Stacked({ top, bottom }: { top: string; bottom: string }): JSX.Element {
  return (
    <span className="history-stack">
      <span>{top}</span>
      <span>{bottom}</span>
    </span>
  )
}

interface HistoryRowProps {
  game: HistoryGame
  onOpen: () => void
  onAnalyze: () => void
}

function HistoryRow({ game, onOpen, onAnalyze }: HistoryRowProps): JSX.Element {
  const [whiteScore, blackScore] = SCORES[game.result] ?? ['–', '–']
  const outcome = outcomeOf(game)
  return (
    // Review and Analyze only understand standard chess, so a variant game has nowhere to open
    <tr className={`history-row${game.variant ? ' static' : ''}`} onClick={game.variant ? undefined : onOpen} data-testid="history-row" data-bot={game.bot} data-variant={game.variant ?? 'standard'}>
      <td className="history-bot">
        <Icon name={BOT_ICONS[game.bot]} size={24} />
        <span>{botName(game.bot, game.variant).replace(' 19', '')}</span>
        {game.variant ? <span className="history-variant">{variantInfo(game.variant).name}</span> : null}
      </td>
      <td>
        <Player game={game} side="white" />
        <Player game={game} side="black" />
      </td>
      <td className="history-center">
        <span className="history-result" data-testid="history-result">
          <Stacked top={whiteScore} bottom={blackScore} />
          {outcome ? (
            <span className={`history-mark ${outcome}`} title={OUTCOMES[outcome].label} role="img" aria-label={OUTCOMES[outcome].label}>
              {OUTCOMES[outcome].mark}
            </span>
          ) : null}
        </span>
      </td>
      <td className="history-center">
        {/* a click on either button bubbles up to the row, which opens the game */}
        {game.variant ? (
          <span className="muted">–</span>
        ) : game.accuracy ? (
          <button type="button" className="history-accuracy" title="Open in Review" data-testid="history-accuracy">
            <Stacked top={formatAccuracy(game.accuracy.white)} bottom={formatAccuracy(game.accuracy.black)} />
          </button>
        ) : (
          <button type="button" className="btn btn-sm" data-testid="history-review">
            Review
          </button>
        )}
      </td>
      <td className="history-center history-moves">{Math.ceil(game.sans.length / 2)}</td>
      <td className="history-center history-date">{formatDate(game.playedAt)}</td>
      <td className="history-center">
        {game.variant ? null : (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            title="Open in Analyze"
            aria-label="Open in Analyze"
            onClick={(e) => {
              e.stopPropagation()
              onAnalyze()
            }}
            data-testid="history-analyze"
          >
            <Icon name="analyze" size={18} />
          </button>
        )}
      </td>
    </tr>
  )
}

export function HistoryTab(): JSX.Element {
  const { navigate } = useApp()
  const [games] = useState(loadHistory)

  return (
    <div className="history-tab" data-testid="history-tab">
      <div className="panel history-panel">
        <div className="panel-header history-header">
          Game History <span className="history-count">({games.length})</span>
        </div>
        {games.length === 0 ? (
          <EmptyState
            icon="history"
            title="No games yet"
            description="Finish a game in Play and it will show up here with the bot, its Elo and your accuracy."
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('play')}>
                Play a game
              </button>
            }
          />
        ) : (
          <div className="history-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th aria-label="Bot" />
                  <th className="history-left">Players</th>
                  <th>Result</th>
                  <th>Accuracy</th>
                  <th className="history-moves">Moves</th>
                  <th className="history-date">Date</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {games.map((game) => (
                  <HistoryRow
                    key={game.id}
                    game={game}
                    onOpen={() => navigate('review', game)}
                    onAnalyze={() => navigate('analyze', { sans: game.sans, startFen: game.startFen })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
