/**
 * Pure helpers for the Learn coach card (no React): the rows shown under the board, the
 * /ws/coach request built for each row, the verdict / explanation cache in localStorage and
 * display strings.
 *
 * Cache keys: the engine verdict of a move depends only on the move (and the fixed engine depth),
 * so it is cached per (opening, node), for every model. The explanation also depends on the model
 * and, for the opponent's moves and off-book moves, on the followed line: the prompt recommends
 * the line's next move / compares with the line's repertoire move. That line-dependent part is the
 * item's `variant`, and explanations are cached per (opening, model, node, variant).
 */
import type { BookMoveNote, Classification, CoachContext, CoachMove, OpeningNode, Side } from '../../api/types'
import { loadJson, removeKey, saveJson } from '../../lib/storage'
import { learnMoveLabel, learnSideToMove } from './learnUtils'

/** localStorage: finished coach verdicts (per node) and explanations (per model + line variant). */
export const LEARN_COACH_CACHE_KEY = 'learn-coach-v2'
/** Older cache (keyed by node only, so it could hold another line's advice): dropped on load. */
const LEARN_COACH_CACHE_KEY_V1 = 'learn-coach-v1'
/** Entries of each kind kept in localStorage (oldest dropped first). */
export const LEARN_COACH_CACHE_MAX = 300
/** Engine depth for practice verdicts (fast: this runs on every practice move). */
export const LEARN_COACH_DEPTH = 14

/** The backend accepts at most 40 repertoire notes per list. */
const MAX_NOTES = 40
const MAX_WHY = 600
/** Plies of engine lines kept in the localStorage cache. */
const MAX_PV = 8

/** What /ws/coach needs for one move. */
export interface LearnCoachItem {
  /** Tree node id, or a virtual id for an off-book move (see `learnOffBookId`). */
  nodeId: string
  /** Position before the move. */
  fen: string
  uci: string
  context: CoachContext
  /**
   * The part of the request that depends on the followed line and changes the explanation: the
   * recommended reply after an opponent move, the compared repertoire move after an off-book
   * move ("" for the student's repertoire moves, whose prompt ignores it).
   */
  variant: string
}

/** One move shown in the coach card. */
export interface LearnCoachRow {
  nodeId: string
  ply: number
  san: string
  /** "1.e4" / "1…e5" */
  label: string
  color: Side
  isStudent: boolean
  /** A repertoire move (a node of the tree). */
  inBook: boolean
  /** Repertoire note ("" for off-book moves). */
  why: string
  nag: string
  item: LearnCoachItem
}

/** A move played on the board that is not in the repertoire (sits on top of a tree node). */
export interface LearnOffBookMove {
  /** Virtual node id (coach cache key). */
  id: string
  baseNodeId: string
  fenBefore: string
  fenAfter: string
  uci: string
  san: string
  /** Ply of the off-book move. */
  ply: number
  color: Side
}

/** Tree nodes by position (see `learnPositionKey`). */
export type LearnPositionIndex = ReadonlyMap<string, readonly OpeningNode[]>

/** Context shared by every request of an opening view. */
export interface LearnCoachBase {
  openingName: string
  lineName?: string
  studentSide: Side
  /** Positions of the tree, so moves reached by transposition count as repertoire moves. */
  positions?: LearnPositionIndex
}

/** Virtual node id of an off-book move (cannot collide with SAN-path ids). */
export function learnOffBookId(baseNodeId: string, uci: string): string {
  return `~${baseNodeId}|${uci}`
}

// ---------------------------------------------------------------- transpositions

/** A position without the move counters (placement, side to move, castling, en passant). */
export function learnPositionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

const INDEX_CACHE = new WeakMap<OpeningNode, Map<string, OpeningNode[]>>()

/** Every node of the tree under `root` by position (memoized per tree). */
export function learnPositionIndex(root: OpeningNode): LearnPositionIndex {
  const cached = INDEX_CACHE.get(root)
  if (cached) return cached
  const index = new Map<string, OpeningNode[]>()
  const stack: OpeningNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop() as OpeningNode
    const key = learnPositionKey(n.fen)
    const list = index.get(key)
    if (list) list.push(n)
    else index.set(key, [n])
    for (const c of n.children) stack.push(c)
  }
  INDEX_CACHE.set(root, index)
  return index
}

/**
 * The repertoire moves in the position of `node`: its own children first, then moves the tree
 * only has after another move order reaching the same position (transpositions). Moves are
 * unique by SAN.
 */
export function learnBookChildren(node: OpeningNode, positions?: LearnPositionIndex): OpeningNode[] {
  const same = positions?.get(learnPositionKey(node.fen))
  if (!same || same.length < 2) return node.children
  const out = [...node.children]
  const seen = new Set(out.map((c) => c.san))
  for (const other of same) {
    if (other === node) continue
    for (const c of other.children) {
      if (seen.has(c.san)) continue
      seen.add(c.san)
      out.push(c)
    }
  }
  return out
}

// ---------------------------------------------------------------- rows

function clip(text: string): string {
  const t = text.trim()
  return t.length > MAX_WHY ? `${t.slice(0, MAX_WHY - 1)}…` : t
}

/** Repertoire moves in the position of `node` as notes; `first` (e.g. the followed line's move) goes first. */
export function learnBookNotes(node: OpeningNode, first?: OpeningNode | null, positions?: LearnPositionIndex): BookMoveNote[] {
  const all = learnBookChildren(node, positions)
  const kids = first ? [first, ...all.filter((c) => c.san !== first.san)] : all
  return kids.slice(0, MAX_NOTES).map((c) => {
    const note: BookMoveNote = { san: c.san, why: clip(c.why), uci: c.uci }
    if (c.nag) note.nag = c.nag
    return note
  })
}

function context(base: LearnCoachBase, bookMoves: BookMoveNote[], replyBookMoves: BookMoveNote[]): CoachContext {
  const ctx: CoachContext = { openingName: base.openingName, studentSide: base.studentSide, bookMoves, replyBookMoves }
  if (base.lineName) ctx.lineName = base.lineName
  return ctx
}

/** Row for the tree move `node` (played from `parent`); `next` = the followed line's next move. */
export function learnTreeRow(base: LearnCoachBase, parent: OpeningNode, node: OpeningNode, next: OpeningNode | null): LearnCoachRow {
  const color = learnSideToMove(node.ply - 1)
  const isStudent = color === base.studentSide
  const replies = learnBookNotes(node, next, base.positions)
  return {
    nodeId: node.id,
    ply: node.ply,
    san: node.san,
    label: learnMoveLabel(node),
    color,
    isStudent,
    inBook: true,
    why: node.why,
    nag: node.nag,
    item: {
      nodeId: node.id,
      fen: parent.fen,
      uci: node.uci,
      context: context(base, learnBookNotes(parent, node, base.positions), replies),
      // the opponent's move: the coach tells the student to answer with replies[0]
      variant: isStudent ? '' : `>${replies[0]?.san ?? ''}`,
    },
  }
}

/** Row for an off-book move played at `at`; `preferred` = the repertoire move of the followed line. */
export function learnOffBookRow(base: LearnCoachBase, at: OpeningNode, move: LearnOffBookMove, preferred: OpeningNode | null): LearnCoachRow {
  const book = learnBookNotes(at, preferred, base.positions)
  return {
    nodeId: move.id,
    ply: move.ply,
    san: move.san,
    label: learnMoveLabel(move),
    color: move.color,
    isStudent: move.color === base.studentSide,
    inBook: false,
    why: '',
    nag: '',
    item: {
      nodeId: move.id,
      fen: at.fen,
      uci: move.uci,
      context: context(base, book, []),
      // the coach compares the move with book[0]
      variant: `=${book[0]?.san ?? ''}`,
    },
  }
}

/**
 * Rows of the coach card for a position on the followed path: the last move and, when that move
 * is the opponent's, the student's move before it (the student move + reply pair). An off-book
 * move on the board replaces them.
 */
export function learnCoachRows(
  base: LearnCoachBase,
  root: OpeningNode,
  path: readonly OpeningNode[],
  ply: number,
  offBook: LearnOffBookMove | null,
): LearnCoachRow[] {
  const at = ply === 0 ? root : path[ply - 1]
  if (offBook && at && offBook.baseNodeId === at.id) return [learnOffBookRow(base, at, offBook, path[ply] ?? null)]
  if (ply === 0 || !at) return []
  const parent = ply >= 2 ? path[ply - 2] : root
  const row = learnTreeRow(base, parent, at, path[ply] ?? null)
  if (row.isStudent || ply < 2) return [row]
  const grand = ply >= 3 ? path[ply - 3] : root
  return [learnTreeRow(base, grand, parent, at), row]
}

// ---------------------------------------------------------------- keys

/** Cache key of a move's engine verdict (the same for every model and line). */
export function learnVerdictKey(openingId: string, nodeId: string): string {
  return `${openingId}|${nodeId}`
}

/** Cache key of a move's explanation ("" model = backend default). */
export function learnTextKey(openingId: string, model: string, item: Pick<LearnCoachItem, 'nodeId' | 'variant'>): string {
  return `${openingId}|${model || 'default'}|${item.nodeId}|${item.variant}`
}

/** A move + line variant, whatever the model (what the student asked about). */
export function learnMoveKey(item: Pick<LearnCoachItem, 'nodeId' | 'variant'>): string {
  return `${item.nodeId}|${item.variant}`
}

// ---------------------------------------------------------------- cache (localStorage)

interface StoredVerdict {
  /** verdict */
  m: CoachMove
  /** last write (Date.now()) */
  t: number
}

interface StoredText {
  /** explanation */
  x: string
  t: number
}

interface StoredCache {
  v: 2
  /** verdicts by `learnVerdictKey` */
  m: Record<string, StoredVerdict>
  /** explanations by `learnTextKey` */
  x: Record<string, StoredText>
}

export interface LearnCachedCoach {
  /** verdict by `learnVerdictKey` */
  verdicts: Record<string, CoachMove>
  /** explanation by `learnTextKey` */
  texts: Record<string, string>
}

function readStore(): StoredCache {
  const raw = loadJson<StoredCache | null>(LEARN_COACH_CACHE_KEY, null)
  const ok = raw && typeof raw === 'object' && raw.v === 2 && raw.m && typeof raw.m === 'object' && raw.x && typeof raw.x === 'object'
  return ok ? raw : { v: 2, m: {}, x: {} }
}

/** Cached verdicts and explanations of one opening (all models). Drops the old v1 cache. */
export function learnLoadCoachCache(openingId: string): LearnCachedCoach {
  removeKey(LEARN_COACH_CACHE_KEY_V1)
  const store = readStore()
  const prefix = `${openingId}|`
  const out: LearnCachedCoach = { verdicts: {}, texts: {} }
  for (const [key, s] of Object.entries(store.m)) {
    if (key.startsWith(prefix) && s && typeof s === 'object' && s.m && typeof s.m.san === 'string') out.verdicts[key] = s.m
  }
  for (const [key, s] of Object.entries(store.x)) {
    if (key.startsWith(prefix) && s && typeof s === 'object' && typeof s.x === 'string' && s.x) out.texts[key] = s.x
  }
  return out
}

function trimMove(m: CoachMove): CoachMove {
  return { ...m, playedPv: m.playedPv.slice(0, MAX_PV), bestMove: { ...m.bestMove, pv: m.bestMove.pv.slice(0, MAX_PV) } }
}

function capped<T extends { t: number }>(rec: Record<string, T>): Record<string, T> {
  const keys = Object.keys(rec)
  if (keys.length <= LEARN_COACH_CACHE_MAX) return rec
  keys.sort((a, b) => (rec[a].t ?? 0) - (rec[b].t ?? 0))
  for (const k of keys.slice(0, keys.length - LEARN_COACH_CACHE_MAX)) delete rec[k]
  return rec
}

/** Store a finished verdict; keeps the newest LEARN_COACH_CACHE_MAX verdicts. */
export function learnSaveCoachVerdict(key: string, move: CoachMove): void {
  const store = readStore()
  store.m[key] = { m: trimMove(move), t: Date.now() }
  capped(store.m)
  saveJson(LEARN_COACH_CACHE_KEY, store)
}

/** Store a finished explanation; keeps the newest LEARN_COACH_CACHE_MAX explanations. */
export function learnSaveCoachText(key: string, text: string): void {
  if (!text) return
  const store = readStore()
  store.x[key] = { x: text, t: Date.now() }
  capped(store.x)
  saveJson(LEARN_COACH_CACHE_KEY, store)
}

// ---------------------------------------------------------------- display

const SOUND: readonly Classification[] = ['brilliant', 'great', 'best', 'excellent', 'good']

/** The engine is happy with the move (best / excellent / good / great / brilliant). */
export function learnIsSoundMove(c: Classification): boolean {
  return SOUND.includes(c)
}

/** "Na3 is an inaccuracy", "e4 is the best move", ... */
export function learnVerdictSentence(label: string, c: Classification): string {
  switch (c) {
    case 'brilliant':
      return `${label} is brilliant`
    case 'great':
      return `${label} is a great move`
    case 'best':
      return `${label} is the best move`
    case 'excellent':
      return `${label} is excellent`
    case 'good':
      return `${label} is a good move`
    case 'book':
      return `${label} is a book move`
    case 'inaccuracy':
      return `${label} is an inaccuracy`
    case 'mistake':
      return `${label} is a mistake`
    case 'blunder':
      return `${label} is a blunder`
    case 'miss':
      return `${label} is a miss`
  }
}

/**
 * For a repertoire move (labelled "book"): the engine's own verdict when it dislikes the move
 * (trap lines, dubious sidelines), from the win% drop with the review thresholds.
 */
export function learnEngineTag(move: CoachMove): Classification | null {
  const drop = move.winPctBefore - move.winPctAfter
  if (drop >= 20) return 'blunder'
  if (drop >= 10) return 'mistake'
  if (drop >= 5) return 'inaccuracy'
  return null
}

/** Short, friendly text for a coach failure. */
export function learnCoachErrorText(message: string, stage: 'analysis' | 'explain'): string {
  const m = message.toLowerCase()
  if (stage === 'explain') {
    if (m.includes('not installed') || m.includes('not found') || m.includes('unknown model')) {
      return `Coach unavailable: the selected Ollama model is not installed.`
    }
    if (m.includes('empty answer')) return 'The coach returned an empty answer.'
    return 'Coach unavailable (is Ollama running?)'
  }
  if (m.includes('connection')) return 'Coach unavailable (is the backend running?)'
  if (m.includes('stockfish') || m.includes('engine')) return 'Engine verdict unavailable (Stockfish not found).'
  return 'Engine verdict unavailable.'
}

/** Light clean-up of model output: markdown emphasis and stray whitespace. */
export function learnCleanCoachText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/\n{3,}/g, '\n\n').trim()
}
