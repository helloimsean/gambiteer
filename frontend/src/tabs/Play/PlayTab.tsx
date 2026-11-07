/**
 * Play tab: a game against Stockfish 19 at a chosen Elo (POST /api/bot/move), optionally starting
 * from one of the opening lines (pre-played, or played out with book hints).
 *
 * State: the game itself is a SAN list (see PlayGame.ts) persisted to localStorage on every change,
 * so switching tabs or reloading resumes it; the bot reply is re-requested when the tab mounts on
 * the bot's turn. Bot replies carry the game id and ply they were asked for and are dropped when the
 * game moved on (takeback, new game) in the meantime.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import * as api from '../../api/client'
import type { BotStrength, Side } from '../../api/types'
import { Board, type BoardShape } from '../../components/Board'
import { ClassificationBadge } from '../../components/ClassificationBadge'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { MoveList } from '../../components/MoveList'
import { Spinner } from '../../components/Spinner'
import { MoveNav, Toolbar, ToolbarButton } from '../../components/Toolbar'
import {
  START_FEN,
  formatSanPath,
  materialInfo,
  moveNumberPrefix,
  oppositeSide,
  parseUci,
  plyOffsetFromFen,
  sanToUci,
  tryMove,
  turnFromFen,
  uciToSan,
  type PromotionPiece,
  type Square,
} from '../../lib/chess'
import { playSound } from '../../lib/sounds'
import { findNodeByPath } from '../../lib/tree'
import { useApp } from '../../state/AppContext'
import {
  BOOK_MOVE_DELAY_MS,
  HINT_DEPTH,
  HINT_DURATION_MS,
  RANDOM_LINE,
  alternativeBookLine,
  bookState,
  botName,
  createGame,
  formatMovetime,
  loadSavedGame,
  loadSetup,
  moverOfPly,
  outcomeFor,
  rematchSetup,
  replayGame,
  resignGame,
  resultHeadline,
  saveGame,
  saveSetup,
  strengthDetail,
  takebackTarget,
  toLastGame,
  toReviewRequest,
  truncateGame,
  withMove,
  type PlayGame,
  type PlaySetup,
} from './PlayGame'
import { PlayGameOverModal } from './PlayGameOverModal'
import { PlayPlayerBar } from './PlayPlayerBar'
import { PlaySetupForm } from './PlaySetupForm'
import { usePlayOpenings } from './usePlayOpenings'
import './PlayTab.css'

/** A rejected non-book move in "play the opening with hints" mode. */
interface BookMiss {
  /** Position it was tried in (the hint disappears once the position changes). */
  fen: string
  attempted: { from: Square; to: Square; promotion?: PromotionPiece; san: string }
  expectedSan: string
  expectedUci: string
}

interface Hint {
  fen: string
  uci: string
  san: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function PlayTab(): JSX.Element {
  const { settings, setLastGame, navigate, playRequest, clearRequest } = useApp()

  const [setup, setSetup] = useState<PlaySetup>(loadSetup)
  const [game, setGame] = useState<PlayGame | null>(loadSavedGame)
  const [flipped, setFlipped] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [overOpen, setOverOpen] = useState(false)
  const [resignOpen, setResignOpen] = useState(false)
  const [viewPly, setViewPly] = useState<number | null>(null)
  const [botThinking, setBotThinking] = useState(false)
  const [botError, setBotError] = useState<string | null>(null)
  const [botRetry, setBotRetry] = useState(0)
  const [strength, setStrength] = useState<BotStrength | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)
  const [hintLoading, setHintLoading] = useState(false)
  const [hintError, setHintError] = useState<string | null>(null)
  const [bookMiss, setBookMiss] = useState<BookMiss | null>(null)
  const [shake, setShake] = useState(0)
  const [startError, setStartError] = useState<string | null>(null)

  const openings = usePlayOpenings([setup.useOpening ? setup.openingId : '', game?.opening?.id ?? ''])
  const setupOpening = setup.useOpening && setup.openingId ? (openings.full[setup.openingId] ?? null) : null
  const gameOpeningFull = game?.opening ? (openings.full[game.opening.id] ?? null) : null

  const updateSetup = useCallback((patch: Partial<PlaySetup>) => {
    setSetup((cur) => {
      const next = { ...cur, ...patch }
      saveSetup(next)
      return next
    })
  }, [])

  // ------------------------------------------------------------ persistence

  useEffect(() => {
    saveGame(game)
  }, [game])

  // ------------------------------------------------------------ derived position

  const startFen = game?.startFen ?? START_FEN
  const sans = game?.sans
  const replay = useMemo(() => (sans ? replayGame(startFen, sans) : null), [startFen, sans])
  const fens = replay?.fens ?? [START_FEN]
  const total = game?.sans.length ?? 0
  const shownPly = viewPly === null ? total : Math.min(viewPly, total)
  const isLive = shownPly === total
  const liveFen = fens[fens.length - 1]
  const fen = fens[shownPly] ?? liveFen
  const shownMove = shownPly > 0 ? replay?.moves[shownPly - 1] : undefined
  const lastMove = shownMove ? `${shownMove.from}${shownMove.to}` : null
  const turn = turnFromFen(liveFen)
  const over = Boolean(game?.result)
  const studentColor: Side = game?.studentColor ?? (setup.color === 'black' ? 'black' : 'white')
  const isStudentTurn = Boolean(game) && !over && turn === studentColor
  const isBotTurn = Boolean(game) && !over && turn !== studentColor
  const canMove = isStudentTurn && isLive && !botThinking
  const orientation: Side = flipped ? oppositeSide(studentColor) : studentColor
  const book = useMemo(() => bookState(game), [game])
  const bookExpected = book?.inBook ? book.expected : null
  const activeMiss = bookMiss && bookMiss.fen === liveFen ? bookMiss : null

  /** "why" of the opening node reached after `path` (empty when unknown). */
  const whyOf = useCallback(
    (path: readonly string[]): string => (gameOpeningFull ? (findNodeByPath(gameOpeningFull.tree, path)?.why ?? '') : ''),
    [gameOpeningFull],
  )

  // a new move (bot reply, takeback, new game) always returns the board to the live position
  useEffect(() => {
    setViewPly(null)
  }, [total, game?.id])

  // ------------------------------------------------------------ bot replies

  const gameId = game?.id
  useEffect(() => {
    if (!game || !isBotTurn) return
    const id = game.id
    const ply = game.sans.length
    const fenNow = liveFen
    setBotError(null)
    setBotThinking(true)

    // hints mode: the bot follows the line while it can
    if (bookExpected) {
      const san = bookExpected
      const timer = setTimeout(() => {
        setBotThinking(false)
        setGame((prev) => (prev && prev.id === id && prev.sans.length === ply ? withMove(prev, san, 'book') : prev))
      }, BOOK_MOVE_DELAY_MS)
      return () => {
        clearTimeout(timer)
        setBotThinking(false)
      }
    }

    const ctrl = new AbortController()
    api
      .botMove({ fen: fenNow, elo: game.elo, movetime_ms: game.movetimeMs }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return
        setBotThinking(false)
        const san = uciToSan(fenNow, res.uci)
        if (!san) {
          setBotError(`The engine answered with an illegal move (${res.uci}).`)
          return
        }
        setStrength(res.strength)
        setGame((prev) => (prev && prev.id === id && prev.sans.length === ply ? withMove(prev, san) : prev))
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setBotThinking(false)
        setBotError(errorText(err))
      })
    return () => {
      ctrl.abort()
      setBotThinking(false)
    }
    // `game` is read for its id/elo/movetime; the position is fully described by gameId + liveFen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, liveFen, isBotTurn, bookExpected, botRetry])

  // ------------------------------------------------------------ game over

  const announcedRef = useRef<string | null>(game?.result ? game.id : null)
  const overTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!game?.result || announcedRef.current === game.id) return
    announcedRef.current = game.id
    setLastGame(toLastGame(game))
    setBookMiss(null)
    setHint(null)
    if (overTimerRef.current) clearTimeout(overTimerRef.current)
    // let the final move land (and its sound play) before the fanfare and the dialog
    overTimerRef.current = setTimeout(() => {
      overTimerRef.current = null
      playSound('gameEnd')
      setOverOpen(true)
    }, 400)
  }, [game, setLastGame])
  useEffect(
    () => () => {
      if (overTimerRef.current) clearTimeout(overTimerRef.current)
    },
    [],
  )

  // ------------------------------------------------------------ hint (one-shot analysis)

  const hintCtrlRef = useRef<AbortController | null>(null)
  useEffect(() => () => hintCtrlRef.current?.abort(), [])
  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), HINT_DURATION_MS)
    return () => clearTimeout(t)
  }, [hint])

  const requestHint = () => {
    if (!canMove || hintLoading) return
    const fenNow = liveFen
    hintCtrlRef.current?.abort()
    const ctrl = new AbortController()
    hintCtrlRef.current = ctrl
    setHintLoading(true)
    setHintError(null)
    api
      .analyzeOnce({ fen: fenNow, multipv: 1, depth: HINT_DEPTH }, ctrl.signal)
      .then((res) => {
        const line = res.lines[0]
        const uci = line?.pvUci[0]
        if (!line || !uci) {
          setHintError('No hint available in this position.')
          return
        }
        setHint({ fen: fenNow, uci, san: line.pv[0] ?? uciToSan(fenNow, uci) ?? uci })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setHintError(errorText(err))
      })
      .finally(() => {
        if (hintCtrlRef.current === ctrl) {
          hintCtrlRef.current = null
          setHintLoading(false)
        }
      })
  }

  // ------------------------------------------------------------ student moves

  const handleMove = (from: Square, to: Square, promotion?: PromotionPiece) => {
    if (!game || !canMove) return
    const mv = tryMove(liveFen, from, to, promotion)
    if (!mv) {
      playSound('illegal')
      return
    }
    setHint(null)
    setHintError(null)

    if (book?.inBook && book.expected && game.opening) {
      if (mv.san === book.expected) {
        setBookMiss(null)
        setGame(withMove(game, mv.san, 'check', { bookStats: { ...game.bookStats, correct: game.bookStats.correct + 1 } }))
        return
      }
      const alt = alternativeBookLine(gameOpeningFull, game.sans, mv.san)
      if (alt) {
        // another book move of this opening: accept it and follow that line from here on
        setBookMiss(null)
        setGame(
          withMove(game, mv.san, 'check', {
            bookStats: { ...game.bookStats, correct: game.bookStats.correct + 1 },
            opening: { ...game.opening, lineId: alt.id, lineName: alt.name, lineSans: [...alt.sans] },
          }),
        )
        return
      }
      // not book: keep the position and show the book move instead
      const firstMissHere = !activeMiss
      setBookMiss({
        fen: liveFen,
        attempted: { from, to, promotion, san: mv.san },
        expectedSan: book.expected,
        expectedUci: sanToUci(liveFen, book.expected) ?? '',
      })
      if (firstMissHere) setGame({ ...game, bookStats: { ...game.bookStats, missed: game.bookStats.missed + 1 } })
      setShake((s) => s + 1)
      playSound('illegal')
      return
    }

    setBookMiss(null)
    setGame(withMove(game, mv.san))
  }

  /** Leave the book: play the rejected move after all. */
  const playAnyway = () => {
    if (!game || !activeMiss || !canMove) return
    const { from, to, promotion } = activeMiss.attempted
    const mv = tryMove(liveFen, from, to, promotion)
    setBookMiss(null)
    if (mv) setGame(withMove(game, mv.san))
  }

  // ------------------------------------------------------------ actions

  const takebackPly = game && !over ? takebackTarget(game) : null
  const takeback = () => {
    if (!game || takebackPly === null) return
    hintCtrlRef.current?.abort()
    setGame(truncateGame(game, takebackPly))
    setViewPly(null)
    setBookMiss(null)
    setHint(null)
    setHintError(null)
    setBotError(null)
  }

  const resign = () => {
    setResignOpen(false)
    if (!game || over) return
    setGame(resignGame(game))
  }

  const startGame = (s: PlaySetup) => {
    let g: PlayGame
    try {
      g = createGame(s, s.useOpening ? (openings.full[s.openingId] ?? null) : null)
    } catch (err) {
      setStartError(errorText(err))
      return
    }
    hintCtrlRef.current?.abort()
    setFlipped(false)
    setViewPly(null)
    setBookMiss(null)
    setHint(null)
    setHintError(null)
    setBotError(null)
    setStrength(null)
    setOverOpen(false)
    setDialogOpen(false)
    setStartError(null)
    setGame(g)
  }

  const openNewGame = () => {
    setStartError(null)
    setOverOpen(false)
    setDialogOpen(true)
  }

  const rematch = () => {
    if (!game) return
    startGame(rematchSetup(game, setup))
  }

  const reviewGame = () => {
    if (!game) return
    setLastGame(toLastGame(game))
    setOverOpen(false)
    navigate('review', toReviewRequest(game))
  }

  // ------------------------------------------------------------ cross-tab request

  const pendingSideRef = useRef<string | null>(null)
  useEffect(() => {
    if (!playRequest) return
    const patch: Partial<PlaySetup> = {}
    if (playRequest.openingId) {
      patch.useOpening = true
      patch.openingId = playRequest.openingId
      patch.lineId = playRequest.lineId ?? RANDOM_LINE
    }
    if (playRequest.color) patch.color = playRequest.color
    else if (playRequest.openingId) {
      const summary = openings.list?.find((o) => o.id === playRequest.openingId)
      if (summary) patch.color = summary.side
      else pendingSideRef.current = playRequest.openingId
    }
    updateSetup(patch)
    if (game) {
      setStartError(null)
      setDialogOpen(true)
    }
    clearRequest('play')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequest, clearRequest, updateSetup])

  useEffect(() => {
    const id = pendingSideRef.current
    if (!id || !openings.list) return
    pendingSideRef.current = null
    const summary = openings.list.find((o) => o.id === id)
    if (summary) updateSetup({ color: summary.side })
  }, [openings.list, updateSetup])

  // ------------------------------------------------------------ board decorations

  const shapes = useMemo<BoardShape[]>(() => {
    const out: BoardShape[] = []
    if (!isLive) return out
    if (hint && hint.fen === fen) {
      const { from, to } = parseUci(hint.uci)
      out.push({ orig: from, dest: to, brush: 'blue' })
    }
    if (activeMiss && activeMiss.expectedUci) {
      const { from, to } = parseUci(activeMiss.expectedUci)
      out.push({ orig: from, dest: to, brush: 'green' })
    }
    return out
  }, [hint, activeMiss, fen, isLive])

  const material = useMemo(() => materialInfo(fen), [fen])
  const elo = game?.elo ?? setup.elo

  const renderBar = (side: Side) => {
    const isStudent = side === studentColor
    return (
      <PlayPlayerBar
        name={isStudent ? 'You' : botName()}
        detail={isStudent ? (game ? side : undefined) : String(elo)}
        icon={isStudent ? 'knight' : 'robot'}
        color={side}
        captured={material.captured[side]}
        advantage={side === 'white' ? material.diff : -material.diff}
        toMove={Boolean(game) && !over && isLive && turn === side}
        thinking={!isStudent && botThinking}
        testId={isStudent ? 'play-bar-you' : 'play-bar-bot'}
      />
    )
  }

  const outcome = game ? outcomeFor(game) : null
  const startDisabled = setup.useOpening && !setupOpening

  // ------------------------------------------------------------ side panel pieces

  const renderStatus = () => {
    if (!game) return null
    if (game.result) {
      return (
        <div className={`play-status over ${outcome ?? ''}`} data-testid="play-status">
          <Icon name={outcome === 'win' ? 'star' : outcome === 'loss' ? 'flag' : 'swords'} size={18} />
          <span className="grow">{resultHeadline(game)}</span>
          <span className="mono bold">{game.result.result}</span>
        </div>
      )
    }
    if (botError) {
      return (
        <div className="play-status error" data-testid="play-status">
          <Icon name="warning" size={18} />
          <span className="grow">Bot move failed: {botError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setBotRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      )
    }
    if (botThinking) {
      return (
        <div className="play-status thinking" data-testid="play-status">
          <Spinner size={16} />
          <span className="grow">{botName()} is thinking...</span>
        </div>
      )
    }
    return (
      <div className="play-status your-move" data-testid="play-status">
        <span className={`play-status-swatch ${studentColor}`} />
        <span className="grow">Your move</span>
        {hintError ? <span className="play-status-note">{hintError}</span> : null}
        {hint && hint.fen === liveFen ? <span className="play-status-note">Hint: {hint.san}</span> : null}
      </div>
    )
  }

  const renderBookEntry = (ply: number) => {
    if (!game || ply < 1 || ply > game.sans.length) return null
    const mark = game.marks[ply]
    if (!mark) return null
    const san = game.sans[ply - 1]
    const why = whyOf(game.sans.slice(0, ply))
    const byStudent = moverOfPly(game.startFen, ply) === game.studentColor
    return (
      <div className={`play-book-entry ${mark}`} key={ply}>
        {mark === 'check' ? (
          <span className="play-book-entry-icon">
            <Icon name="check" size={14} strokeWidth={2.4} />
          </span>
        ) : (
          <ClassificationBadge classification="book" size={20} className="play-book-entry-badge" title="Book move" />
        )}
        <div className="play-book-entry-text">
          <div>
            <strong>
              {moveNumberPrefix(ply + plyOffsetFromFen(game.startFen))}
              {san}
            </strong>{' '}
            <span className="muted">{mark === 'check' ? 'is book. Well played!' : byStudent ? '(book)' : `${botName()} follows the line.`}</span>
          </div>
          {why ? <div className="play-book-why">{why}</div> : null}
        </div>
      </div>
    )
  }

  const renderOpening = () => {
    const o = game?.opening
    if (!game || !o) return null
    const ply = game.sans.length
    const offset = plyOffsetFromFen(game.startFen)
    return (
      <div className="play-book" data-testid="play-book">
        <div className="play-book-head">
          <ClassificationBadge classification="book" size={18} title="Opening line" />
          <div className="play-book-title">
            <strong className="truncate" title={o.name}>
              {o.name}
            </strong>
            <span className="truncate muted" title={o.lineName}>
              {o.lineName}
            </span>
          </div>
          <span className="badge">{o.mode === 'hints' ? 'with hints' : 'from end of line'}</span>
        </div>
        {o.mode === 'end' ? (
          <div className="play-book-body">
            <div className="play-book-line mono" title={formatSanPath(o.lineSans)}>
              {formatSanPath(o.lineSans)}
            </div>
            {!game.result && game.sans.length === game.basePly ? (
              <div className="muted small">The line is on the board. The game starts here.</div>
            ) : null}
          </div>
        ) : (
          <div className="play-book-body">
            {activeMiss ? (
              <div className="play-book-entry miss" data-testid="play-book-miss">
                <span className="play-book-entry-icon">
                  <Icon name="close" size={14} strokeWidth={2.4} />
                </span>
                <div className="play-book-entry-text">
                  <div>
                    <strong>{activeMiss.attempted.san}</strong> <span className="muted">is not the book move. The line continues</span>{' '}
                    <strong>
                      {moveNumberPrefix(ply + 1 + offset)}
                      {activeMiss.expectedSan}
                    </strong>
                    .
                  </div>
                  {whyOf([...game.sans, activeMiss.expectedSan]) ? (
                    <div className="play-book-why">{whyOf([...game.sans, activeMiss.expectedSan])}</div>
                  ) : null}
                  <button type="button" className="btn btn-sm play-anyway" onClick={playAnyway} data-testid="play-anyway">
                    Play {activeMiss.attempted.san} anyway (leave the book)
                  </button>
                </div>
              </div>
            ) : (
              <>
                {renderBookEntry(ply - 1)}
                {renderBookEntry(ply)}
              </>
            )}
            {book?.inBook && isStudentTurn && !activeMiss ? <div className="play-book-prompt">Your move: play the book move.</div> : null}
            {book?.completed ? (
              <div className="play-book-prompt done">End of the line. From here you are on your own.</div>
            ) : null}
            {book?.left ? <div className="play-book-prompt left">You left the book after {book.followed} plies.</div> : null}
            <div className="play-book-stats">
              Book moves: <strong className="ok">{game.bookStats.correct}</strong> correct, <strong className="bad">{game.bookStats.missed}</strong> missed
            </div>
          </div>
        )}
      </div>
    )
  }

  // ------------------------------------------------------------ render

  const boardStyle = { '--below-board-h': '160px' } as CSSProperties
  const topSide = oppositeSide(orientation)

  return (
    <div
      className="workspace play-tab"
      data-testid="play-tab"
      data-game-id={game?.id ?? ''}
      data-turn={turn}
      data-over={over ? 'true' : 'false'}
      data-thinking={botThinking ? 'true' : 'false'}
      data-plies={total}
    >
      <div className="workspace-board play-board-col" style={boardStyle}>
        <div className="play-bar-slot">{renderBar(topSide)}</div>
        <div className="board-frame">
          <Board
            fen={fen}
            orientation={orientation}
            lastMove={lastMove}
            interactive={canMove}
            movableColor={game ? studentColor : 'none'}
            onMove={handleMove}
            shapes={shapes}
            coordinates={settings.coordinates}
            shake={shake}
          />
        </div>
        <div className="play-bar-slot">{renderBar(orientation)}</div>
        <Toolbar className="play-toolbar">
          {game && !over ? (
            <>
              <ToolbarButton icon="flag" label="Resign" title="Resign" onClick={() => setResignOpen(true)} />
              <ToolbarButton icon="undo" label="Takeback" title="Take back your last move (and the bot's reply)" onClick={takeback} disabled={takebackPly === null} />
              <ToolbarButton
                icon="hint"
                label={hintLoading ? 'Thinking...' : 'Hint'}
                title={`Show the engine's best move for ${HINT_DURATION_MS / 1000} s`}
                onClick={requestHint}
                disabled={!canMove || hintLoading}
              />
            </>
          ) : null}
          {game && over ? (
            <>
              <ToolbarButton icon="review" label="Review" title="Review this game" onClick={reviewGame} primary />
              <ToolbarButton icon="refresh" label="Rematch" title="Rematch" onClick={rematch} />
            </>
          ) : null}
          <ToolbarButton icon="flip" title="Flip board" onClick={() => setFlipped((f) => !f)} active={flipped} />
          {game ? <ToolbarButton icon="plus" label="New game" title="New game" onClick={openNewGame} /> : null}
        </Toolbar>
      </div>

      <div className="workspace-side">
        {game ? (
          <div className="panel grow play-panel">
            <div className="panel-header">
              <Icon name="robot" size={18} />
              <span className="panel-title">vs {botName()}</span>
              <span className="badge badge-green" title={strengthDetail(strength, game.elo)}>
                {game.elo}
              </span>
              <span className="badge" title="Bot move time">
                {formatMovetime(game.movetimeMs)}
              </span>
            </div>
            <div className="play-panel-top">
              {renderStatus()}
              <div className="play-strength muted small" title="Strength mode reported by the backend">
                {strengthDetail(strength, game.elo)}
              </div>
              {renderOpening()}
              {!isLive ? (
                <div className="play-viewing">
                  <span className="grow">Viewing move {moveNumberPrefix(shownPly + plyOffsetFromFen(game.startFen))}{game.sans[shownPly - 1] ?? 'start'}</span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setViewPly(null)}>
                    Back to game
                  </button>
                </div>
              ) : null}
            </div>
            <MoveList
              className="play-moves grow"
              moves={game.sans}
              currentPly={shownPly}
              startPly={plyOffsetFromFen(game.startFen)}
              onSelect={(p) => setViewPly(p >= total ? null : p)}
              emptyText={isStudentTurn ? 'Make your first move' : 'Waiting for the first move'}
              renderBadge={(p) => {
                const mark = game.marks[p]
                if (!mark) return null
                if (mark === 'book') return <ClassificationBadge classification="book" size={16} className="play-mark book" title="Book move" />
                return (
                  <span className="play-mark check" title="Book move found">
                    <Icon name="check" size={12} strokeWidth={2.6} />
                  </span>
                )
              }}
            />
            {over ? (
              <div className="panel-footer play-over-actions">
                <button type="button" className="btn btn-primary grow" onClick={reviewGame} data-testid="play-review">
                  <Icon name="review" size={16} /> Review this game
                </button>
                <button type="button" className="btn" onClick={rematch}>
                  <Icon name="refresh" size={16} /> Rematch
                </button>
              </div>
            ) : null}
            <div className="panel-footer play-nav">
              <MoveNav ply={shownPly} maxPly={total} onChange={(p) => setViewPly(p >= total ? null : p)} keyboard />
            </div>
          </div>
        ) : (
          <div className="panel grow play-panel">
            <div className="panel-header">
              <Icon name="robot" size={18} />
              <span className="panel-title">Play vs {botName()}</span>
            </div>
            <div className="panel-body scroll grow">
              <PlaySetupForm
                setup={setup}
                onChange={updateSetup}
                openings={openings.list}
                openingsError={openings.listError}
                opening={setupOpening}
                openingError={setup.useOpening ? (openings.errors[setup.openingId] ?? null) : null}
                onRetry={openings.reload}
              />
            </div>
            <div className="panel-footer col play-start-footer">
              {startError ? <div className="play-inline-error">{startError}</div> : null}
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={() => startGame(setup)}
                disabled={startDisabled}
                data-testid="play-start"
              >
                <Icon name="play" size={18} /> Start game
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="New game"
        width={520}
        className="play-new-modal"
        footer={
          <>
            {startError ? <span className="play-inline-error grow">{startError}</span> : null}
            <button type="button" className="btn btn-ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => startGame(setup)} disabled={startDisabled} data-testid="play-start">
              <Icon name="play" size={16} /> Start game
            </button>
          </>
        }
      >
        {game && !game.result ? (
          <div className="play-warning">
            <Icon name="warning" size={16} /> Starting a new game abandons the current one.
          </div>
        ) : null}
        <PlaySetupForm
          setup={setup}
          onChange={updateSetup}
          openings={openings.list}
          openingsError={openings.listError}
          opening={setupOpening}
          openingError={setup.useOpening ? (openings.errors[setup.openingId] ?? null) : null}
          onRetry={openings.reload}
        />
      </Modal>

      <Modal
        open={resignOpen}
        onClose={() => setResignOpen(false)}
        title="Resign?"
        width={380}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setResignOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={resign} data-testid="play-resign-confirm">
              <Icon name="flag" size={16} /> Resign
            </button>
          </>
        }
      >
        <p>Resign this game against {botName()} ({elo})?</p>
      </Modal>

      <PlayGameOverModal
        open={overOpen}
        game={game}
        onClose={() => setOverOpen(false)}
        onReview={reviewGame}
        onRematch={rematch}
        onNewGame={openNewGame}
      />
    </div>
  )
}
