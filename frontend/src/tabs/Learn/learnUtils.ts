/**
 * Pure helpers for the Learn tab (no React).
 */
import { LINE_CATEGORIES, type LineCategory, type LineMeta, type OpeningNode, type OpeningSummary } from '../../api/types'
import { sanPathToMoves, START_FEN } from '../../lib/chess'
import { t } from '../../lib/i18n'
import { pathToNode } from '../../lib/tree'

/** Autoplay speed (one move every 1.5 s). */
export const LEARN_AUTOPLAY_MS = 1500
/** Delay before the opponent's automatic reply during practice. */
export const LEARN_REPLY_MS = 600
/** localStorage: the opening / position the student last looked at (restored when the tab remounts). */
export const LEARN_LAST_KEY = 'learn-last-v1'
/** localStorage: show next-move arrows on the board. */
export const LEARN_ARROWS_KEY = 'learn-arrows-v1'
/** localStorage: practice options ({ autoReply, replyMode, autoExplain }). */
export const LEARN_PRACTICE_KEY = 'learn-practice-v1'

export interface LearnLastState {
  openingId: string
  nodeId: string
  lineId: string | null
}

/**
 * Navigation state of the opening view: the followed line, its nodes and the position on it.
 */
export interface LearnNavState {
  lineId: string | null
  /** Nodes of the followed path, root excluded. */
  path: OpeningNode[]
  /** 0 = initial position, i = after path[i - 1]. */
  ply: number
}

/** Node shown for a navigation state (the root at ply 0). */
export function learnNavNode(root: OpeningNode, nav: LearnNavState): OpeningNode {
  const ply = Math.min(nav.ply, nav.path.length)
  return ply === 0 ? root : nav.path[ply - 1]
}

/** Navigation state after jumping to `node` (follows `preferLineId` when it passes through). */
export function learnNavAtNode(
  root: OpeningNode,
  lines: readonly LineMeta[],
  node: OpeningNode,
  preferLineId: string | null,
): LearnNavState {
  const line = learnPickLine(node, lines, preferLineId)
  if (line) {
    const nodes = learnLineNodes(root, line)
    if (node.ply === 0 || nodes[node.ply - 1]?.id === node.id) return { lineId: line.id, path: nodes, ply: node.ply }
  }
  // no line passes through the node (should not happen with valid data): follow first children
  const path = pathToNode(root, node.id) ?? []
  let n = node
  while (n.children.length > 0) {
    n = n.children[0]
    path.push(n)
  }
  return { lineId: null, path, ply: node.ply }
}

/** Side to move after `ply` plies from the initial position. */
export function learnSideToMove(ply: number): 'white' | 'black' {
  return ply % 2 === 0 ? 'white' : 'black'
}

/**
 * A child of `node` picked at random, weighted by the number of lines passing through it (so
 * popular replies come up more often). `rand` is injectable for tests.
 */
export function learnWeightedChild(node: OpeningNode, rand: () => number = Math.random): OpeningNode | null {
  const kids = node.children
  if (kids.length === 0) return null
  const weight = (c: OpeningNode) => Math.max(1, c.lineIds.length)
  const total = kids.reduce((s, c) => s + weight(c), 0)
  let r = rand() * total
  for (const c of kids) {
    r -= weight(c)
    if (r < 0) return c
  }
  return kids[kids.length - 1]
}

const PREFERRED_NEXT: readonly string[] = ['main', 'accepted', 'declined']

/**
 * "Next line" after completing one: a random other line, preferring lines not yet completed this
 * session and, among those, main / accepted / declined lines.
 */
export function learnPickNextLine(
  lines: readonly LineMeta[],
  currentId: string | null,
  completed: ReadonlySet<string>,
  rand: () => number = Math.random,
): LineMeta | null {
  const others = lines.filter((l) => l.id !== currentId)
  if (others.length === 0) return lines[0] ?? null
  const fresh = others.filter((l) => !completed.has(l.id))
  const pool = fresh.length > 0 ? fresh : others
  const preferred = pool.filter((l) => PREFERRED_NEXT.includes(l.category))
  const pick = preferred.length > 0 ? preferred : pool
  return pick[Math.min(pick.length - 1, Math.floor(rand() * pick.length))]
}

/** Gambit openings get a prominent "If declined" section. */
export function learnIsGambit(name: string): boolean {
  return /gambit/i.test(name)
}

/** Position of a category in the display order (Main, Accepted, Declined, Alternatives, ...). */
export function learnCategoryRank(category: string): number {
  const i = LINE_CATEGORIES.indexOf(category as LineCategory)
  return i < 0 ? LINE_CATEGORIES.length : i
}

/** First sentence of a paragraph ("1.e4" style move numbers do not end a sentence). */
export function learnFirstSentence(text: string): string {
  const t = text.trim()
  const m = t.match(/^[\s\S]*?[.!?](?=\s+[A-Z("'0-9]|$)/)
  return (m ? m[0] : t).trim()
}

/**
 * Gallery order: "primary" openings first. There is no explicit flag in the data, so the fuller
 * repertoires (more lines) count as primary; ties are broken by name.
 */
export function learnSortOpenings(list: readonly OpeningSummary[]): OpeningSummary[] {
  return [...list].sort((a, b) => b.lineCount - a.lineCount || a.name.localeCompare(b.name))
}

function stripSan(s: string): string {
  return s.replace(/[+#!?]+$/, '')
}

/**
 * Number of plies that define the opening, read from the `family` text ("1.e4 e5 2.Nc3 Vienna
 * Game" -> 3) by matching its leading moves against the main line. Falls back to 6 plies.
 */
export function learnDefiningPlies(o: OpeningSummary): number {
  const tokens = (o.family || '').split(/\s+/)
  let n = 0
  for (const raw of tokens) {
    const t = raw.replace(/^\d+\.(\.\.)?/, '').replace(/^…/, '')
    if (t === '') continue
    if (n < o.mainLineSans.length && stripSan(t) === stripSan(o.mainLineSans[n])) n += 1
    else break
  }
  if (n === 0) n = Math.min(6, o.mainLineSans.length)
  return n
}

/** Position (and last move) shown on a gallery card. */
export function learnPreview(o: OpeningSummary): { fen: string; lastMove: [string, string] | null; sans: string[] } {
  const sans = o.mainLineSans.slice(0, learnDefiningPlies(o))
  try {
    const moves = sanPathToMoves(sans)
    const last = moves[moves.length - 1]
    return { fen: last ? last.after : START_FEN, lastMove: last ? [last.from, last.to] : null, sans }
  } catch {
    return { fen: START_FEN, lastMove: null, sans: [] }
  }
}

/** Nodes of a line from the root (excluded) to its last move. */
export function learnLineNodes(root: OpeningNode, line: LineMeta): OpeningNode[] {
  return pathToNode(root, line.sans.join(' ')) ?? []
}

/**
 * Where a line "starts": the first node that belongs to this line only. A line that is a strict
 * prefix of another one has no such node, so its last node is used.
 */
export function learnLineStartNode(nodes: readonly OpeningNode[], lineId: string): OpeningNode | null {
  for (const n of nodes) {
    if (n.lineIds.length === 1 && n.lineIds[0] === lineId) return n
  }
  return nodes[nodes.length - 1] ?? null
}

/**
 * Ply to show when a line is picked from the Lines panel: main lines start from the initial
 * position, every other line at its first move off the main line.
 */
export function learnLineEntryPly(nodes: readonly OpeningNode[], category: string): number {
  if (category === 'main') return 0
  const i = nodes.findIndex((n) => !n.mainLine)
  return i < 0 ? 0 : i + 1
}

/** Lines through a node, best category first (stable within a category). */
export function learnLinesThroughSorted(node: OpeningNode, lines: readonly LineMeta[]): LineMeta[] {
  const set = new Set(node.lineIds)
  return lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => set.has(l.id))
    .sort((a, b) => learnCategoryRank(a.l.category) - learnCategoryRank(b.l.category) || a.i - b.i)
    .map(({ l }) => l)
}

/**
 * The line to follow after jumping to `node`: the active line when it passes through the node,
 * else the line the tree shows inline after the node (first children down to a leaf), else the
 * best-ranked line through the node.
 */
export function learnPickLine(node: OpeningNode, lines: readonly LineMeta[], activeLineId: string | null): LineMeta | null {
  if (activeLineId && node.lineIds.includes(activeLineId)) {
    const active = lines.find((l) => l.id === activeLineId)
    if (active) return active
  }
  let leaf = node
  while (leaf.children.length > 0) leaf = leaf.children[0]
  const ending = lines.find((l) => l.sans.length === leaf.ply && leaf.lineIds.includes(l.id))
  if (ending && node.lineIds.includes(ending.id)) return ending
  return learnLinesThroughSorted(node, lines)[0] ?? null
}

/** Does the subtree rooted at `node` contain the node with this id? (ids are SAN paths) */
export function learnSubtreeHas(node: OpeningNode, id: string | null): boolean {
  if (id === null) return false
  if (node.id === '') return true
  return id === node.id || id.startsWith(node.id + ' ')
}

/** "1." / "1…" move label for a node. */
export function learnMoveLabel(node: Pick<OpeningNode, 'ply' | 'san'>): string {
  if (node.ply === 0) return ''
  const n = Math.ceil(node.ply / 2)
  return node.ply % 2 === 1 ? `${n}.${node.san}` : `${n}…${node.san}`
}

const NAG_MEANINGS: Record<string, string> = {
  '!': t('good move'),
  '!!': t('brilliant move'),
  '!?': t('interesting move'),
  '?!': t('dubious move'),
  '?': t('mistake'),
  '??': t('blunder'),
}

export function learnNagMeaning(nag: string): string {
  return NAG_MEANINGS[nag] ?? ''
}

export function learnNagClass(nag: string): string {
  if (nag === '!' || nag === '!!') return 'good'
  if (nag === '?' || nag === '??') return 'bad'
  return 'warn'
}

/** Short label for a source URL ("chess.com/openings/Caro-Kann..."); non-URLs are returned as-is. */
export function learnSourceLabel(src: string): { href: string | null; label: string } {
  try {
    const u = new URL(src)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { href: null, label: src }
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '')
    return { href: u.href, label: `${u.hostname.replace(/^www\./, '')}${path}` }
  } catch {
    return { href: null, label: src }
  }
}
