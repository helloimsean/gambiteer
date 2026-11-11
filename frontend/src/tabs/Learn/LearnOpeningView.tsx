/**
 * LearnOpeningView: board (oriented to the student's side) + the current move, the coach card
 * (repertoire "why", engine verdict, streamed coach explanation) + navigation/autoplay/practice
 * under it, and a side panel with Tree / Lines / Ideas.
 *
 * Navigation model: the view always follows one line (`nav.lineId`, highlighted in the tree) and
 * `nav.ply` is the position on it. Jumping to a node picks the line to follow (the active line if
 * it passes through, else the line the tree shows inline after the node), so "next" always goes
 * where the highlighted path goes.
 *
 * Practice (useLearnPractice): a move played on the board is answered by the opponent from the
 * line; browsing never triggers a reply. The coach (useLearnCoach) explains practice moves.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { LineMeta, OpeningFull, OpeningNode } from '../../api/types'
import { LINE_CATEGORY_LABELS } from '../../api/types'
import { Board, type BoardShape } from '../../components/Board'
import { Icon } from '../../components/Icon'
import { MoveNav, ToolbarButton } from '../../components/Toolbar'
import { parseUci } from '../../lib/chess'
import { loadJson, saveJson } from '../../lib/storage'
import { deepestNodeOnPath, findNodeById, sansFromNodeId } from '../../lib/tree'
import { t, tn } from '../../lib/i18n'
import { useApp } from '../../state/AppContext'
import { LearnCoachCard } from './LearnCoachCard'
import { LearnIdeasPanel } from './LearnIdeasPanel'
import { LearnLinesPanel } from './LearnLinesPanel'
import { LearnPracticeMenu } from './LearnPracticeMenu'
import { LearnTree } from './LearnTree'
import { learnBookChildren, learnCoachRows, learnPositionIndex, type LearnCoachRow } from './learnCoach'
import {
  LEARN_ARROWS_KEY,
  LEARN_AUTOPLAY_MS,
  LEARN_LAST_KEY,
  learnIsGambit,
  learnLineEntryPly,
  learnLineNodes,
  learnLinesThroughSorted,
  learnLineStartNode,
  learnMoveLabel,
  learnNagClass,
  learnNagMeaning,
  learnNavAtNode,
  learnSideToMove,
  type LearnLastState,
  type LearnNavState,
} from './learnUtils'
import { useLearnCoach } from './useLearnCoach'
import { useLearnPractice } from './useLearnPractice'

export interface LearnInitial {
  /** Node to open at (SAN path id). */
  nodeId?: string
  /** Line to follow (when it passes through the node). */
  lineId?: string | null
  /** Changes whenever a new request arrives, so the view re-applies it. */
  token: number
}

export interface LearnOpeningViewProps {
  opening: OpeningFull
  initial?: LearnInitial
  onBack: () => void
}

type PanelTab = 'tree' | 'lines' | 'ideas'

/** Alternative moves drawn as pale arrows (children are ordered main first, then by line count). */
const MAX_ALT_ARROWS = 4

function initialNav(opening: OpeningFull, initial?: LearnInitial): LearnNavState {
  let node: OpeningNode = opening.tree
  if (initial?.nodeId) {
    node = findNodeById(opening.tree, initial.nodeId) ?? deepestNodeOnPath(opening.tree, sansFromNodeId(initial.nodeId)).node
  }
  return learnNavAtNode(opening.tree, opening.lines, node, initial?.lineId ?? null)
}

export function LearnOpeningView({ opening, initial, onBack }: LearnOpeningViewProps): JSX.Element {
  const { navigate, settings } = useApp()
  const root = opening.tree
  const [nav, setNav] = useState<LearnNavState>(() => initialNav(opening, initial))
  const [panel, setPanel] = useState<PanelTab>('tree')
  const [autoplay, setAutoplay] = useState(false)
  const [arrows, setArrows] = useState<boolean>(() => loadJson<boolean>(LEARN_ARROWS_KEY, true) !== false)
  const [expandAll, setExpandAll] = useState(false)
  const [showAllLines, setShowAllLines] = useState(false)

  const stopAutoplay = useCallback(() => setAutoplay(false), [])
  const practice = useLearnPractice({ opening, nav, setNav, stopAutoplay })
  const coach = useLearnCoach(opening.id, settings.ollamaModel)
  const { cancel: cancelPractice, takeBack } = practice

  // a new request (same opening) while mounted: re-apply it (state adjusted during render)
  const [prevToken, setPrevToken] = useState(initial?.token)
  if (initial && initial.token !== prevToken) {
    setPrevToken(initial.token)
    setNav(initialNav(opening, initial))
    setAutoplay(false)
  }
  // ...and drop any practice state of the old position (a pending reply re-checks it anyway)
  const tokenRef = useRef(initial?.token)
  useEffect(() => {
    if (tokenRef.current === initial?.token) return
    tokenRef.current = initial?.token
    cancelPractice()
  }, [initial?.token, cancelPractice])

  const ply = Math.min(nav.ply, nav.path.length)
  const node: OpeningNode = ply === 0 ? root : nav.path[ply - 1]
  const nextNode: OpeningNode | undefined = nav.path[ply]
  const lineById = useMemo(() => new Map(opening.lines.map((l) => [l.id, l])), [opening.lines])
  const activeLine = nav.lineId ? (lineById.get(nav.lineId) ?? null) : null
  const sansHere = useMemo(() => nav.path.slice(0, ply).map((n) => n.san), [nav.path, ply])
  const offBook = practice.offBook

  // node id -> lines that start there (first node unique to the line)
  const chips = useMemo(() => {
    const m = new Map<string, LineMeta[]>()
    for (const l of opening.lines) {
      const start = learnLineStartNode(learnLineNodes(root, l), l.id)
      if (!start) continue
      const arr = m.get(start.id) ?? []
      arr.push(l)
      m.set(start.id, arr)
    }
    return m
  }, [opening.lines, root])

  const activeIds = useMemo(() => new Set(nav.lineId ? nav.path.map((n) => n.id) : []), [nav.lineId, nav.path])
  const linesHere = useMemo(() => {
    const sorted = learnLinesThroughSorted(node, opening.lines)
    if (!activeLine) return sorted
    return [...sorted.filter((l) => l.id === activeLine.id), ...sorted.filter((l) => l.id !== activeLine.id)]
  }, [node, opening.lines, activeLine])

  // reset per-node UI bits when the position changes (state adjusted during render)
  const [prevNodeId, setPrevNodeId] = useState(node.id)
  if (prevNodeId !== node.id) {
    setPrevNodeId(node.id)
    setShowAllLines(false)
  }

  // ---------------------------------------------------------------- actions
  // Every browsing action cancels practice state (pending reply, off-book move, complete card).

  const goToNode = useCallback(
    (target: OpeningNode, preferLineId?: string | null) => {
      setAutoplay(false)
      cancelPractice()
      setNav((cur) => learnNavAtNode(root, opening.lines, target, preferLineId === undefined ? cur.lineId : preferLineId))
    },
    [root, opening.lines, cancelPractice],
  )

  const setPly = useCallback(
    (p: number) => {
      // "Previous move" with an off-book move on the board goes back to the position before it
      // (the off-book move sits one ply above the current node), like Left / Backspace / Esc
      if (offBook && p === ply - 1) {
        takeBack()
        return
      }
      setAutoplay(false)
      cancelPractice()
      setNav((cur) => ({ ...cur, ply: Math.max(0, Math.min(cur.path.length, p)) }))
    },
    [cancelPractice, takeBack, offBook, ply],
  )

  const followLine = useCallback(
    (line: LineMeta, atPly?: number) => {
      setAutoplay(false)
      cancelPractice({ newRun: true })
      const nodes = learnLineNodes(root, line)
      const p = atPly ?? learnLineEntryPly(nodes, line.category)
      setNav({ lineId: line.id, path: nodes, ply: Math.max(0, Math.min(nodes.length, p)) })
    },
    [root, cancelPractice],
  )

  const onChipLine = useCallback(
    (line: LineMeta, at: OpeningNode) => {
      followLine(line, at.ply)
    },
    [followLine],
  )

  const toggleAutoplay = useCallback(() => {
    cancelPractice()
    if (autoplay && ply < nav.path.length) {
      setAutoplay(false)
      return
    }
    if (ply >= nav.path.length) setNav((cur) => ({ ...cur, ply: 0 }))
    setAutoplay(true)
  }, [autoplay, ply, nav.path.length, cancelPractice])

  const running = autoplay && ply < nav.path.length
  const pathLength = nav.path.length
  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => {
      const next = Math.min(pathLength, ply + 1)
      setNav((cur) => ({ ...cur, ply: Math.min(cur.path.length, next) }))
      if (next >= pathLength) setAutoplay(false)
    }, LEARN_AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [running, ply, pathLength])

  // remember where the student was, so coming back to the tab restores it
  useEffect(() => {
    const state: LearnLastState = { openingId: opening.id, nodeId: node.id, lineId: nav.lineId }
    saveJson(LEARN_LAST_KEY, state)
  }, [opening.id, node.id, nav.lineId])

  const toggleArrows = useCallback(() => {
    setArrows((a) => {
      saveJson(LEARN_ARROWS_KEY, !a)
      return !a
    })
  }, [])

  // ---------------------------------------------------------------- coach

  const positions = useMemo(() => learnPositionIndex(root), [root])
  const coachBase = useMemo(
    () => ({ openingName: opening.name, lineName: activeLine?.name, studentSide: opening.side, positions }),
    [opening.name, opening.side, activeLine?.name, positions],
  )
  const rows = useMemo(() => learnCoachRows(coachBase, root, nav.path, ply, offBook), [coachBase, root, nav.path, ply, offBook])
  const rowItems = useMemo(() => rows.map((r) => r.item), [rows])

  // moves just played in practice: engine verdict always, explanation when auto-explain is on.
  // Called on every change of the rows (also while browsing, with no items), so work that was
  // asked for and dropped or lost resumes when its move is on screen again. `ensure` changes
  // with the coach model, so a model switch re-requests the explanations of the moves in focus.
  const { ensure } = coach
  const { focus } = practice
  const autoExplain = practice.settings.autoExplain
  useEffect(() => {
    const items = rows.filter((r) => focus.includes(r.nodeId)).map((r) => r.item)
    ensure(items, { explain: autoExplain }, rowItems)
  }, [rows, rowItems, focus, autoExplain, ensure])

  const askCoach = useCallback((row: LearnCoachRow) => ensure([row.item], { explain: true, retry: true }, rowItems), [ensure, rowItems])

  // ---------------------------------------------------------------- board

  /** The repertoire move an off-book move is compared with (the followed line's, else the first, transpositions included). */
  const repertoireMove = offBook ? (nextNode ?? learnBookChildren(node, positions)[0] ?? null) : null

  // while practising, the next-move arrows would show the answer on the student's own turn: they
  // are hidden there until the student asks for a hint (the arrows button) for this position
  const practising = practice.active && !offBook && learnSideToMove(node.ply) === opening.side && node.children.length > 0
  const [hintAt, setHintAt] = useState<string | null>(null)
  const hideAnswer = practising && hintAt !== node.id
  const arrowsShown = arrows && !hideAnswer
  const onArrowsButton = useCallback(() => {
    if (arrows && hideAnswer) {
      setHintAt(node.id)
      return
    }
    if (!arrows) setHintAt(node.id) // turning arrows on also shows them for this position
    toggleArrows()
  }, [arrows, hideAnswer, node.id, toggleArrows])

  const shapes = useMemo<BoardShape[]>(() => {
    if (offBook) {
      // off book: the repertoire move as a green arrow (always, it is the feedback)
      if (!repertoireMove?.uci || repertoireMove.uci.length < 4) return []
      const { from, to } = parseUci(repertoireMove.uci)
      return [{ orig: from, dest: to, brush: 'green' }]
    }
    if (!arrowsShown) return []
    const out: BoardShape[] = []
    let main: BoardShape | null = null
    for (const c of node.children) {
      if (!c.uci || c.uci.length < 4) continue
      const { from, to } = parseUci(c.uci)
      if (nextNode && c.id === nextNode.id) main = { orig: from, dest: to, brush: 'green' }
      else if (out.length < MAX_ALT_ARROWS) out.push({ orig: from, dest: to, brush: 'paleBlue', lineWidth: 7 })
    }
    if (main) out.push(main) // drawn last = on top
    return out
  }, [arrowsShown, node, nextNode, offBook, repertoireMove])

  const studentMoved = node.ply > 0 && (node.ply % 2 === 1 ? 'white' : 'black') === opening.side
  const atEnd = ply > 0 && ply >= nav.path.length
  const VISIBLE_LINE_CHIPS = 3
  const shownLines = showAllLines ? linesHere : linesHere.slice(0, VISIBLE_LINE_CHIPS)
  const { autoReply } = practice.settings

  return (
    <div className="workspace learn-view">
      <div className="workspace-board">
        <div className="board-frame">
          <Board
            fen={offBook ? offBook.fenAfter : node.fen}
            orientation={opening.side}
            lastMove={offBook ? offBook.uci : node.uci || null}
            interactive={!offBook}
            movableColor={autoReply ? opening.side : 'both'}
            onMove={practice.onBoardMove}
            shapes={shapes}
            coordinates={settings.coordinates}
            animation={220}
          />
        </div>

        <div
          className="learn-below"
          data-line-id={nav.lineId ?? ''}
          data-ply={ply}
          data-node-id={node.id}
          data-practising={practice.active ? 'true' : 'false'}
        >
          <div className="learn-move-head">
            {offBook ? (
              <>
                <span className="learn-move-big" data-testid="learn-current-move">
                  {learnMoveLabel(offBook)}
                </span>
                <span className="badge badge-yellow">{t('Not in repertoire')}</span>
              </>
            ) : node.ply === 0 ? (
              <span className="learn-move-big">{t('Starting position')}</span>
            ) : (
              <>
                <span className="learn-move-big" data-testid="learn-current-move">
                  {learnMoveLabel(node)}
                  {node.nag ? <span className={`nag ${learnNagClass(node.nag)}`}>{node.nag}</span> : null}
                </span>
                {node.nag ? <span className={`learn-nag-meaning ${learnNagClass(node.nag)}`}>{learnNagMeaning(node.nag)}</span> : null}
                <span className={`badge ${studentMoved ? 'badge-green' : ''}`}>{studentMoved ? t('Your move') : t("Opponent's move")}</span>
              </>
            )}
            <span className="spacer" />
            {practice.pendingReply ? (
              <span className="learn-thinking dim" data-testid="learn-reply-pending">
                {t('Opponent is replying…')}
              </span>
            ) : null}
            <span className="learn-ply-count dim" title={t('Move on this line')}>
              {ply}/{nav.path.length}
            </span>
            <button
              type="button"
              className={`btn btn-ghost btn-icon btn-sm learn-arrows-toggle${arrowsShown ? ' on' : ''}${arrows && hideAnswer ? ' hint' : ''}`}
              title={
                arrows && hideAnswer
                  ? t('Hint: show the repertoire move (arrows are hidden on your turn while you practise)')
                  : arrows
                    ? t('Hide move arrows')
                    : t('Show move arrows')
              }
              aria-label={arrows && hideAnswer ? t('Show a hint') : arrows ? t('Hide move arrows') : t('Show move arrows')}
              aria-pressed={arrowsShown}
              data-testid="learn-arrows-toggle"
              onClick={onArrowsButton}
            >
              <Icon name="hint" size={16} />
            </button>
            <LearnPracticeMenu settings={practice.settings} onChange={practice.setSettings} model={settings.ollamaModel} />
          </div>

          <LearnCoachCard
            rows={rows}
            entry={coach.entry}
            onAsk={askCoach}
            offBook={
              offBook
                ? {
                    repertoire: repertoireMove,
                    onTakeBack: practice.takeBack,
                    onAnalyze: () => navigate('analyze', { sans: [...sansHere, offBook.san] }),
                  }
                : null
            }
            complete={practice.complete}
            onPracticeAgain={() => practice.start()}
            onNextLine={practice.nextLine}
            canPlayOpponent={practice.canPlayOpponent}
            onPlayOpponent={practice.playOpponentMove}
            placeholder={
              <span className="muted learn-coach-intro">
                {t(
                  'Play your move on the board and the opponent answers from the line, with a coach explaining every move. Or step through with',
                )}{' '}
                <span className="kbd">→</span>
                {t(', Autoplay, or click any move in the tree.')}
                {activeLine ? (
                  <>
                    {' '}
                    {t('Following:')} <b className="learn-following">{activeLine.name}</b>
                  </>
                ) : null}
              </span>
            }
            footer={
              atEnd && activeLine && !practice.complete && !offBook ? (
                <div className="learn-end">
                  <b>{t('End of line.')}</b> {activeLine.evaluation || t('No evaluation given.')}
                </div>
              ) : node.ply > 0 && !node.why && !offBook ? (
                <span className="muted small">{t('No repertoire note for this move.')}</span>
              ) : null
            }
          />

          <div className={`learn-here${showAllLines ? ' expanded' : ''}`}>
            {node.ply === 0 ? (
              <span className="dim">
                {tn(opening.lines.length, '{n} line in this repertoire.', '{n} lines in this repertoire.')}{' '}
                {learnIsGambit(opening.name) ? t('See "If declined" in Lines.') : ''}
              </span>
            ) : (
              <>
                <span className="dim learn-here-label">{tn(linesHere.length, 'Line:', '{n} lines:')}</span>
                {shownLines.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`learn-chip cat-${l.category}${l.id === nav.lineId ? ' active' : ''}`}
                    title={t('{category}: {name}', { category: (LINE_CATEGORY_LABELS[l.category] ?? l.category), name: l.name })}
                    onClick={() => followLine(l, ply)}
                  >
                    {l.name}
                  </button>
                ))}
                {linesHere.length > VISIBLE_LINE_CHIPS ? (
                  <button type="button" className="learn-link" onClick={() => setShowAllLines((s) => !s)}>
                    {showAllLines ? t('show less') : t('+{n} more', { n: linesHere.length - VISIBLE_LINE_CHIPS })}
                  </button>
                ) : null}
              </>
            )}
          </div>

          <div className="learn-controls">
            <MoveNav ply={ply} maxPly={nav.path.length} onChange={setPly} keyboard className="learn-nav">
              <ToolbarButton
                icon={running ? 'pause' : 'autoplay'}
                title={running ? t('Pause autoplay') : t('Autoplay (1.5 s per move)')}
                label={running ? t('Pause') : t('Autoplay')}
                active={running}
                onClick={toggleAutoplay}
                disabled={nav.path.length === 0}
                className="learn-autoplay-btn"
              />
              <ToolbarButton
                icon="target"
                title={t('Practice this line from the start: you play {side}, the opponent answers', {
                  side: opening.side === 'white' ? t('White') : t('Black'),
                })}
                label={t('Practice')}
                onClick={() => practice.start()}
                disabled={nav.path.length === 0}
                className="learn-practice-btn"
              />
            </MoveNav>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-primary learn-action"
              onClick={() => navigate('quiz', { openingId: opening.id })}
              title={t('Quiz this opening')}
            >
              <Icon name="quiz" size={16} />
              <span className="learn-label-long">{t('Quiz this opening')}</span>
              <span className="learn-label-short">{t('Quiz')}</span>
            </button>
            <button
              type="button"
              className="btn learn-action learn-analyze-action"
              onClick={() => navigate('analyze', { sans: sansHere })}
              title={t('Analyze this position')}
            >
              <Icon name="analyze" size={16} />
              <span className="learn-label-long">{t('Analyze this position')}</span>
              <span className="learn-label-short">{t('Analyze')}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="workspace-side">
        <div className="panel grow learn-side">
          <div className="panel-header learn-side-header">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onBack} title={t('All openings')} aria-label={t('All openings')}>
              <Icon name="prev" size={18} />
            </button>
            <div className="panel-title learn-side-title">
              <div className="truncate" title={opening.name}>
                {opening.name}
              </div>
              <div className="row gap-4">
                <span className={`badge badge-${opening.side}`}>{opening.side === 'white' ? 'White' : 'Black'}</span>
                {opening.eco ? <span className="badge badge-eco">{opening.eco}</span> : null}
              </div>
            </div>
          </div>
          <div className="panel-tabs" role="tablist">
            {(['tree', 'lines', 'ideas'] as const).map((tk) => (
              <button
                key={tk}
                type="button"
                role="tab"
                aria-selected={panel === tk}
                className={panel === tk ? 'active' : ''}
                onClick={() => setPanel(tk)}
              >
                {tk === 'tree' ? t('Tree') : tk === 'lines' ? t('Lines ({count})', { count: opening.lines.length }) : t('Ideas')}
              </button>
            ))}
          </div>
          <div className="learn-side-body">
            {panel === 'tree' ? (
              <>
                <div className="learn-tree-bar">
                  <span className="dim learn-tree-legend">
                    <b>{t('Bold')}</b> {t('= main line · chips mark where a line starts')}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandAll((e) => !e)}>
                    {expandAll ? t('Collapse') : t('Expand all')}
                  </button>
                </div>
                <LearnTree
                  key={expandAll ? 'open' : 'auto'}
                  root={root}
                  lines={opening.lines}
                  selectedId={node.id}
                  activeLineId={nav.lineId}
                  activeIds={activeIds}
                  chips={chips}
                  onSelectNode={goToNode}
                  onSelectLine={onChipLine}
                  autoCollapseDepth={expandAll ? 99 : 1}
                />
              </>
            ) : panel === 'lines' ? (
              <LearnLinesPanel
                openingName={opening.name}
                lines={opening.lines}
                activeLineId={nav.lineId}
                ply={ply}
                onSelectLine={(l) => followLine(l)}
                onJump={(l, p) => followLine(l, p)}
                onDrill={(l) => navigate('quiz', { openingId: opening.id, lineId: l.id, mode: 'line' })}
              />
            ) : (
              <LearnIdeasPanel opening={opening} activeLineId={nav.lineId} onSelectLine={(l) => followLine(l)} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
