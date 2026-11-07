/**
 * Practice on the Learn board.
 *
 * - The student plays a repertoire move on the board; the opponent answers automatically after
 *   LEARN_REPLY_MS with the followed line's next move ("Follow line") or a random child of the
 *   tree weighted by line count ("Random variation", which switches the followed line).
 * - A move that is not in the repertoire stays on the board (on top of the current node) until it
 *   is taken back; there is no reply off book.
 * - Reaching the end of the followed line by playing shows a "Line complete" summary.
 * - Browsing (arrows, tree, lines, autoplay) never triggers a reply: every browsing action calls
 *   `cancel()`, and a reply timer re-checks the position when it fires, so a reply is never
 *   applied to a position that changed in the meantime.
 * - A repertoire move reached by another move order (a transposition) counts as in book: the
 *   board jumps to that node of the tree.
 * - A reply still pending when the view unmounts (tab switch, reload) is remembered in
 *   sessionStorage and played when the view comes back to the same position.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { LineMeta, OpeningFull, OpeningNode } from '../../api/types'
import { tryMove, type PromotionPiece, type Square } from '../../lib/chess'
import { loadJson, loadSessionJson, saveJson, saveSessionJson } from '../../lib/storage'
import { learnBookChildren, learnOffBookId, learnPositionIndex, type LearnOffBookMove } from './learnCoach'
import {
  LEARN_PRACTICE_KEY,
  LEARN_REPLY_MS,
  learnLineNodes,
  learnNavAtNode,
  learnNavNode,
  learnPickNextLine,
  learnSideToMove,
  learnWeightedChild,
  type LearnNavState,
} from './learnUtils'

export type LearnReplyMode = 'line' | 'random'

export interface LearnPracticeSettings {
  /** The opponent answers the student's board moves automatically. */
  autoReply: boolean
  replyMode: LearnReplyMode
  /** Ask the coach (Ollama) to explain every move played during practice. */
  autoExplain: boolean
}

export const LEARN_PRACTICE_DEFAULTS: LearnPracticeSettings = { autoReply: true, replyMode: 'line', autoExplain: true }

/** sessionStorage: the reply scheduled when the view unmounted ({ openingId, nodeId }). */
const REPLY_RESUME_KEY = 'learn-reply-pending-v1'
interface ReplyResume {
  openingId: string
  nodeId: string
}

function loadSettings(): LearnPracticeSettings {
  const s = loadJson<Partial<Record<keyof LearnPracticeSettings, unknown>> | null>(LEARN_PRACTICE_KEY, null)
  const out = { ...LEARN_PRACTICE_DEFAULTS }
  if (!s || typeof s !== 'object') return out
  if (typeof s.autoReply === 'boolean') out.autoReply = s.autoReply
  if (s.replyMode === 'line' || s.replyMode === 'random') out.replyMode = s.replyMode
  if (typeof s.autoExplain === 'boolean') out.autoExplain = s.autoExplain
  return out
}

export interface LearnOffBook extends LearnOffBookMove {
  /** Practice focus before the off-book move (restored by take back). */
  prevFocus: readonly string[]
}

export interface LearnLineComplete {
  /** Node where the line ended (the card shows only there). */
  nodeId: string
  lineId: string | null
  lineName: string
  evaluation: string
  /** Student moves played in this run. */
  moves: number
  /** Off-book attempts in this run. */
  offBook: number
}

export interface LearnPracticeArgs {
  opening: OpeningFull
  nav: LearnNavState
  setNav: Dispatch<SetStateAction<LearnNavState>>
  stopAutoplay: () => void
}

export interface LearnPracticeApi {
  settings: LearnPracticeSettings
  setSettings: (patch: Partial<LearnPracticeSettings>) => void
  /** Off-book move on top of the current node, or null. */
  offBook: LearnOffBook | null
  /** An automatic reply is scheduled from the current node. */
  pendingReply: boolean
  /** "Line complete" summary for the current node, or null. */
  complete: LearnLineComplete | null
  /** Node ids of the last moves played in practice (the coach explains these automatically). */
  focus: readonly string[]
  /**
   * The student is practising (Practice, a move on the board, the opponent's reply) rather than
   * browsing; cleared by every browsing action. The view hides the answer arrows meanwhile.
   */
  active: boolean
  /** Auto-reply is on, it is the opponent's turn and nothing is scheduled: offer the button. */
  canPlayOpponent: boolean
  onBoardMove: (from: Square, to: Square, promotion?: PromotionPiece) => void
  playOpponentMove: () => void
  takeBack: () => void
  /** Rewind `line` (default: the followed line) to the start; plays the opponent's first move if they start. */
  start: (line?: LineMeta) => void
  /** Practise a random other line (prefers main / accepted / declined, not completed yet). */
  nextLine: () => void
  /**
   * Browsing: drop a scheduled reply, the off-book move and the complete card. `newRun` also
   * resets the move / off-book counters (a line was picked explicitly).
   */
  cancel: (opts?: { newRun?: boolean }) => void
}

function typingInField(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

export function useLearnPractice({ opening, nav, setNav, stopAutoplay }: LearnPracticeArgs): LearnPracticeApi {
  const root = opening.tree
  const [settings, setSettingsState] = useState<LearnPracticeSettings>(loadSettings)
  /** Node id the scheduled reply was planned from. */
  const [pendingAt, setPendingAt] = useState<string | null>(null)
  const [offBookState, setOffBook] = useState<LearnOffBook | null>(null)
  const [completeState, setComplete] = useState<LearnLineComplete | null>(null)
  const [focus, setFocus] = useState<readonly string[]>([])
  const [active, setActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runRef = useRef({ moves: 0, offBook: 0 })
  const completedRef = useRef(new Set<string>())
  const navRef = useRef(nav)
  const settingsRef = useRef(settings)
  const offBookRef = useRef(offBookState)
  useLayoutEffect(() => {
    navRef.current = nav
    settingsRef.current = settings
    offBookRef.current = offBookState
  })

  const node = learnNavNode(root, nav)
  const offBook = offBookState && offBookState.baseNodeId === node.id ? offBookState : null
  const complete = completeState && completeState.nodeId === node.id && !offBook ? completeState : null
  const pendingReply = pendingAt !== null && pendingAt === node.id

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      saveSessionJson(REPLY_RESUME_KEY, undefined)
    }
    timerRef.current = null
    setPendingAt(null)
  }, [])

  // unmount (tab left, opening changed): no reply may fire afterwards (a pending one stays in
  // sessionStorage and resumes when the view comes back to the same position)
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    },
    [],
  )

  /** Show the summary when `next` is at the end of its line. Returns true when it is. */
  const finishIfEnd = useCallback(
    (next: LearnNavState, nodeId: string): boolean => {
      if (next.path.length === 0 || next.ply < next.path.length) return false
      const line = next.lineId ? opening.lines.find((l) => l.id === next.lineId) : undefined
      if (line) completedRef.current.add(line.id)
      setComplete({
        nodeId,
        lineId: next.lineId,
        lineName: line?.name ?? 'this line',
        evaluation: line?.evaluation ?? '',
        moves: runRef.current.moves,
        offBook: runRef.current.offBook,
      })
      return true
    },
    [opening.lines],
  )

  /** The opponent's move at `at` (the node of `cur`) and the navigation state after it. */
  const pickReply = useCallback(
    (cur: LearnNavState, at: OpeningNode): { reply: OpeningNode; next: LearnNavState } | null => {
      const onLine = cur.path[at.ply]
      if (settingsRef.current.replyMode === 'random') {
        const r = learnWeightedChild(at)
        if (!r) return null
        if (onLine && onLine.id === r.id) return { reply: r, next: { ...cur, ply: at.ply + 1 } }
        return { reply: r, next: learnNavAtNode(root, opening.lines, r, cur.lineId) }
      }
      if (!onLine) return null // end of the followed line
      return { reply: onLine, next: { ...cur, ply: at.ply + 1 } }
    },
    [root, opening.lines],
  )

  /** Play the opponent's move at `at` (the node of `cur`). */
  const applyReply = useCallback(
    (cur: LearnNavState, at: OpeningNode) => {
      const pick = pickReply(cur, at)
      if (!pick) return
      setNav(pick.next)
      setFocus((f) => (f.length === 1 && f[0] === at.id ? [at.id, pick.reply.id] : [pick.reply.id]))
      finishIfEnd(pick.next, pick.reply.id)
    },
    [pickReply, setNav, finishIfEnd],
  )

  const schedule = useCallback(
    (baseId: string) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      setPendingAt(baseId)
      const resume: ReplyResume = { openingId: opening.id, nodeId: baseId }
      saveSessionJson(REPLY_RESUME_KEY, resume)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        saveSessionJson(REPLY_RESUME_KEY, undefined)
        setPendingAt(null)
        const cur = navRef.current
        const at = learnNavNode(root, cur)
        // the position changed (navigation, take back, new line...): never apply a stale reply
        if (at.id !== baseId || offBookRef.current?.baseNodeId === at.id) return
        if (learnSideToMove(at.ply) === opening.side) return
        applyReply(cur, at)
      }, LEARN_REPLY_MS)
    },
    [root, opening.id, opening.side, applyReply],
  )

  // a reply that was pending when the view unmounted: play it if we are back at that position
  useEffect(() => {
    const saved = loadSessionJson<ReplyResume | null>(REPLY_RESUME_KEY, null)
    if (!saved || saved.openingId !== opening.id || timerRef.current !== null) return
    const at = learnNavNode(root, navRef.current)
    if (at.id !== saved.nodeId || learnSideToMove(at.ply) === opening.side || !settingsRef.current.autoReply) return
    setActive(true)
    setFocus((f) => (f.length > 0 ? f : at.ply > 0 ? [at.id] : []))
    schedule(at.id)
  }, [opening.id, opening.side, root, schedule])

  const onBoardMove = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece) => {
      if (offBook) return
      const mv = tryMove(node.fen, from, to, promotion)
      if (!mv) return
      const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`
      const mover = learnSideToMove(node.ply)
      const isStudent = mover === opening.side
      clearTimer()
      stopAutoplay()
      setActive(true)
      // a new run: after a completed line, or when the student plays their first move again
      // after playing some (not when the opponent's first move is played by hand)
      const firstStudentPly = opening.side === 'white' ? 0 : 1
      if (complete || (isStudent && node.ply === firstStudentPly && runRef.current.moves > 0)) runRef.current = { moves: 0, offBook: 0 }
      setComplete(null)
      const isMove = (c: OpeningNode) => c.san === mv.san || c.uci === uci
      // a repertoire move, also when the tree only has it after another move order (transposition)
      const child = node.children.find(isMove) ?? learnBookChildren(node, learnPositionIndex(root)).find(isMove)
      if (child) {
        const next = learnNavAtNode(root, opening.lines, child, nav.lineId)
        setNav(next)
        if (isStudent) runRef.current.moves += 1
        setFocus((f) => (!isStudent && f.length === 1 && f[0] === node.id ? [node.id, child.id] : [child.id]))
        if (finishIfEnd(next, child.id)) return
        if (isStudent && settingsRef.current.autoReply) schedule(child.id)
        return
      }
      // not in the repertoire: keep it on the board until taken back
      if (isStudent) runRef.current.offBook += 1
      const id = learnOffBookId(node.id, uci)
      setOffBook({
        id,
        baseNodeId: node.id,
        fenBefore: node.fen,
        fenAfter: mv.after,
        uci,
        san: mv.san,
        ply: node.ply + 1,
        color: mover,
        prevFocus: focus,
      })
      setFocus([id])
    },
    [offBook, node, opening.side, opening.lines, root, nav.lineId, complete, focus, clearTimer, stopAutoplay, setNav, finishIfEnd, schedule],
  )

  const canPlayOpponent =
    settings.autoReply &&
    !offBook &&
    !pendingReply &&
    learnSideToMove(node.ply) !== opening.side &&
    (settings.replyMode === 'random' ? node.children.length > 0 : nav.path[node.ply] !== undefined)

  const playOpponentMove = useCallback(() => {
    if (!canPlayOpponent) return
    clearTimer()
    stopAutoplay()
    setComplete(null)
    setActive(true)
    applyReply(nav, node)
  }, [canPlayOpponent, clearTimer, stopAutoplay, applyReply, nav, node])

  const takeBack = useCallback(() => {
    const ob = offBookRef.current
    if (!ob) return
    setOffBook(null)
    setFocus(ob.prevFocus)
  }, [])

  const cancel = useCallback(
    (opts?: { newRun?: boolean }) => {
      clearTimer()
      setOffBook(null)
      setComplete(null)
      setActive(false)
      if (opts?.newRun) runRef.current = { moves: 0, offBook: 0 }
    },
    [clearTimer],
  )

  const start = useCallback(
    (line?: LineMeta) => {
      clearTimer()
      stopAutoplay()
      setOffBook(null)
      setComplete(null)
      setFocus([])
      setActive(true)
      runRef.current = { moves: 0, offBook: 0 }
      const target = line ?? (nav.lineId ? opening.lines.find((l) => l.id === nav.lineId) : undefined)
      const next: LearnNavState = target ? { lineId: target.id, path: learnLineNodes(root, target), ply: 0 } : { ...nav, ply: 0 }
      setNav(next)
      // the opponent starts (the student plays Black): play their first move
      if (opening.side === 'black' && next.path.length > 0) schedule(root.id)
    },
    [clearTimer, stopAutoplay, nav, opening.lines, opening.side, root, setNav, schedule],
  )

  const nextLine = useCallback(() => {
    const line = learnPickNextLine(opening.lines, nav.lineId, completedRef.current)
    if (line) start(line)
  }, [opening.lines, nav.lineId, start])

  const setSettings = useCallback(
    (patch: Partial<LearnPracticeSettings>) => {
      if (patch.autoReply !== undefined && patch.autoReply !== settingsRef.current.autoReply) clearTimer()
      setSettingsState((cur) => {
        const next = { ...cur, ...patch }
        saveJson(LEARN_PRACTICE_KEY, next)
        return next
      })
    },
    [clearTimer],
  )

  // keys: Left / Backspace / Esc take an off-book move back; Space plays the opponent's move.
  // Capture phase, so this runs before MoveNav's arrow keys (which skip prevented events).
  useEffect(() => {
    if (!offBook && !canPlayOpponent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingInField()) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      // an open menu (Practice options) owns Escape: it closes the menu, nothing else
      if (e.key === 'Escape' && document.querySelector('[role="menu"]')) return
      if (offBook && (e.key === 'ArrowLeft' || e.key === 'Backspace' || e.key === 'Escape')) {
        e.preventDefault()
        takeBack()
        return
      }
      if (canPlayOpponent && e.key === ' ') {
        e.preventDefault()
        // a focused button would also be "clicked" by the space key on keyup
        const el = document.activeElement
        if (el instanceof HTMLElement && el.tagName === 'BUTTON') el.blur()
        playOpponentMove()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [offBook, canPlayOpponent, takeBack, playOpponentMove])

  return {
    settings,
    setSettings,
    offBook,
    pendingReply,
    complete,
    focus,
    active,
    canPlayOpponent,
    onBoardMove,
    playOpponentMove,
    takeBack,
    start,
    nextLine,
    cancel,
  }
}
