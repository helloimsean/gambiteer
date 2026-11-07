/**
 * Quiz exercises ("tasks") and the pure rules behind them.
 *
 * A task is one exercise on the board:
 *  - line:      play a whole line from move 1; the app plays the opponent's moves from the line.
 *  - positions: one position from the tree where the student is to move; any book child is right.
 *  - traps:     a position from a trap line right after the opponent went wrong; find the
 *               punishing move, then keep going to the end of the trap line.
 *
 * Everything here is pure (no React), so the runner hook only has to apply these rules.
 */
import { Chess } from 'chess.js'
import { LINE_CATEGORIES, LINE_CATEGORY_LABELS, type LineMeta, type OpeningFull, type OpeningNode, type QuizItem, type Side } from '../../api/types'
import { START_FEN, moveToUci, sanPathToMoves, sanToUci, turnFromFen } from '../../lib/chess'
import { findNodeByPath, nodeIdFromSans } from '../../lib/tree'
import { pickWeighted, tierOf, type QuizStats } from './QuizStats'

export type QuizMode = 'line' | 'positions' | 'traps'

export const QUIZ_MODES: readonly { id: QuizMode; label: string; hint: string }[] = [
  { id: 'line', label: 'Line drill', hint: 'Play a whole line from move 1. The app answers with the book reply.' },
  { id: 'positions', label: 'Positions', hint: 'Random positions from your repertoire. Any book move counts.' },
  { id: 'traps', label: 'Traps', hint: 'The opponent just went wrong. Find the punishing moves.' },
]

/** Value of the line picker meaning "pick a line for me". */
export const RANDOM_LINE = 'random'

export function lineKey(openingId: string, lineId: string): string {
  return `${openingId}::${lineId}`
}

export function parseLineKey(key: string): { openingId: string; lineId: string } | null {
  const i = key.indexOf('::')
  if (i < 0) return null
  return { openingId: key.slice(0, i), lineId: key.slice(i + 2) }
}

export interface QuizTask {
  /** Unique per run (remounts the exercise). */
  key: string
  mode: QuizMode
  openingId: string
  openingName: string
  /** The side the student plays. */
  side: Side
  tree: OpeningNode | null
  /** All lines of the opening (for names and trap continuations). */
  lines: LineMeta[]
  /** Moves already on the board when the exercise starts. */
  startSans: string[]
  /** Line drill: the line to play. */
  line?: LineMeta
  /** Positions / traps: the quiz item. */
  item?: QuizItem
  /** Traps: lines that continue the tactic after the item position. */
  trapLines?: LineMeta[]
}

/** A move the student may play at the current turn. */
export interface ExpectedMove {
  san: string
  uci: string
  why: string
  lineNames: string[]
}

let taskCounter = 0
function newKey(): string {
  taskCounter += 1
  return `${Date.now().toString(36)}-${taskCounter}`
}

/** Same task, fresh run (restart). */
export function restartTask(task: QuizTask): QuizTask {
  return { ...task, key: newKey() }
}

// ---------------------------------------------------------------- SAN helpers

/** SAN without check/mate/annotation marks, for tolerant comparisons. */
export function bareSan(san: string): string {
  return san.replace(/[+#!?]/g, '')
}

export function sameSan(a: string, b: string): boolean {
  return bareSan(a) === bareSan(b)
}

export function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) if (!sameSan(prefix[i], full[i])) return false
  return true
}

/** Play a SAN move on a FEN; null when illegal. */
export function playSan(fen: string, san: string): { fen: string; uci: string; san: string } | null {
  try {
    const chess = new Chess(fen)
    const m = chess.move(san)
    return { fen: chess.fen(), uci: moveToUci(m), san: m.san }
  } catch {
    return null
  }
}

/** FEN and last move (UCI) after a SAN path from the initial position. */
export function positionAfter(sans: readonly string[]): { fen: string; lastUci: string | null } {
  if (sans.length === 0) return { fen: START_FEN, lastUci: null }
  const moves = sanPathToMoves(sans)
  const last = moves[moves.length - 1]
  return { fen: last.after, lastUci: moveToUci(last) }
}

function whyAt(tree: OpeningNode | null, sans: readonly string[]): string {
  if (!tree) return ''
  return findNodeByPath(tree, sans)?.why ?? ''
}

function lineNamesAt(task: QuizTask, sans: readonly string[]): string[] {
  if (!task.tree) return []
  const node = findNodeByPath(task.tree, sans)
  if (!node) return []
  const byId = new Map(task.lines.map((l) => [l.id, l.name]))
  return node.lineIds.map((id) => byId.get(id)).filter((n): n is string => !!n)
}

// ---------------------------------------------------------------- building tasks

export function buildLineTask(opening: OpeningFull, line: LineMeta): QuizTask {
  return {
    key: newKey(),
    mode: 'line',
    openingId: opening.id,
    openingName: opening.name,
    side: opening.side,
    tree: opening.tree,
    lines: opening.lines,
    startSans: [],
    line,
  }
}

/** Lines that continue a trap item: through one of its answers, preferring `trap` lines. */
export function trapContinuationLines(item: QuizItem, lines: readonly LineMeta[]): LineMeta[] {
  const ids = new Set(item.answers.flatMap((a) => a.lineIds))
  const through = lines.filter((l) => ids.has(l.id) && l.sans.length > item.sanPath.length && isPrefix(item.sanPath, l.sans))
  const traps = through.filter((l) => l.category === 'trap')
  return traps.length ? traps : through
}

/** FEN without the move counters (positions reached by different move orders compare equal). */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

/**
 * Position quiz: add the book moves of transposed twins (same position reached by another move
 * order in the same opening), so any move the repertoire plays in this position counts.
 */
export function withTranspositions(item: QuizItem, pool: readonly QuizItem[]): QuizItem {
  const key = positionKey(item.fen)
  const twins = pool.filter((i) => i !== item && i.openingId === item.openingId && positionKey(i.fen) === key)
  if (twins.length === 0) return item
  const answers = [...item.answers]
  for (const t of twins) {
    for (const a of t.answers) {
      const same = answers.find((x) => x.uci === a.uci)
      if (!same) answers.push(a)
      else {
        const lineIds = [...same.lineIds, ...a.lineIds.filter((id) => !same.lineIds.includes(id))]
        const lineNames = [...same.lineNames, ...a.lineNames.filter((n) => !same.lineNames.includes(n))]
        answers[answers.indexOf(same)] = { ...same, why: same.why || a.why, lineIds, lineNames }
      }
    }
  }
  return { ...item, answers }
}

export function buildItemTask(mode: 'positions' | 'traps', item: QuizItem, opening: OpeningFull | undefined, side: Side): QuizTask {
  return {
    key: newKey(),
    mode,
    openingId: item.openingId,
    openingName: item.openingName,
    side,
    tree: opening?.tree ?? null,
    lines: opening?.lines ?? [],
    startSans: item.sanPath,
    item,
    trapLines: mode === 'traps' && opening ? trapContinuationLines(item, opening.lines) : undefined,
  }
}

// ---------------------------------------------------------------- choosing what to ask

/** Indices i such that the student is to move after sans[0..i) (i.e. sans[i] is a student move). */
export function studentPlies(line: LineMeta, side: Side): number[] {
  const out: number[] = []
  for (let i = 0; i < line.sans.length; i++) {
    const whiteToMove = i % 2 === 0
    if ((side === 'white') === whiteToMove) out.push(i)
  }
  return out
}

export interface LineCandidate {
  opening: OpeningFull
  line: LineMeta
}

/** Weight of a line for "random line": weak and unseen positions make a line more likely. */
export function lineWeight(c: LineCandidate, stats: QuizStats): number {
  const plies = studentPlies(c.line, c.opening.side)
  if (plies.length === 0) return 0.5
  const nodes = stats[c.opening.id] ?? {}
  let weak = 0
  let unseen = 0
  for (const i of plies) {
    const t = tierOf(nodes[nodeIdFromSans(c.line.sans.slice(0, i))])
    if (t === 0) weak += 1
    else if (t === 1) unseen += 1
  }
  return 1 + (6 * weak) / plies.length + (3 * unseen) / plies.length
}

export function pickRandomLine(cands: readonly LineCandidate[], stats: QuizStats, excludeKey?: string): LineCandidate | null {
  const pool = cands.length > 1 ? cands.filter((c) => lineKey(c.opening.id, c.line.id) !== excludeKey) : cands
  return pickWeighted(pool, (c) => lineWeight(c, stats))
}

export function itemKey(item: QuizItem): string {
  return `${item.openingId}|${item.id}`
}

/**
 * Next quiz item: weak positions first (wrong >= correct), then unseen ones (shallow first-ish),
 * then known ones (stalest first-ish). The last few items asked are skipped so nothing repeats
 * back to back.
 */
export function pickItem(items: readonly QuizItem[], stats: QuizStats, recent: readonly string[], now = Date.now()): QuizItem | null {
  if (items.length === 0) return null
  const cooldown = new Set(recent.slice(-Math.min(5, Math.floor(items.length / 2))))
  let pool = items.filter((i) => !cooldown.has(itemKey(i)))
  if (pool.length === 0) pool = [...items]
  const tiers: QuizItem[][] = [[], [], []]
  for (const it of pool) tiers[tierOf(stats[it.openingId]?.[it.id])].push(it)
  const tier = tiers.findIndex((t) => t.length > 0)
  const chosen = tiers[tier]
  return pickWeighted(chosen, (it) => {
    const s = stats[it.openingId]?.[it.id]
    if (tier === 0 && s) return 1 + (s.wrong - s.correct) + Math.min(24, (now - s.lastSeen) / 3_600_000)
    if (tier === 1) return 1 / (1 + it.sanPath.length / 6)
    if (s) return (1 + Math.min(72, (now - s.lastSeen) / 3_600_000)) / (1 + s.correct - s.wrong)
    return 1
  })
}

// ---------------------------------------------------------------- exercise rules

/** Trap lines still consistent with the moves played. */
export function consistentLines(lines: readonly LineMeta[], sans: readonly string[]): LineMeta[] {
  return lines.filter((l) => isPrefix(sans, l.sans))
}

/** Lines (from `lines`) that have a move after `sans`. */
function extending(lines: readonly LineMeta[], sans: readonly string[]): LineMeta[] {
  return lines.filter((l) => l.sans.length > sans.length && isPrefix(sans, l.sans))
}

/** Is the exercise over at this point (ignoring a forced end after a wrong position answer)? */
export function isFinished(task: QuizTask, sans: readonly string[], chosen: readonly LineMeta[]): boolean {
  switch (task.mode) {
    case 'line':
      return !task.line || sans.length >= task.line.sans.length
    case 'positions':
      return sans.length > task.startSans.length
    case 'traps':
      if (sans.length <= task.startSans.length) return false
      return extending(chosen, sans).length === 0
  }
}

/** The moves the student may play now. */
export function expectedMoves(task: QuizTask, sans: readonly string[], fen: string, chosen: readonly LineMeta[]): ExpectedMove[] {
  if ((task.mode === 'positions' || task.mode === 'traps') && sans.length === task.startSans.length && task.item) {
    return task.item.answers.map((a) => ({ san: a.san, uci: a.uci, why: a.why, lineNames: a.lineNames }))
  }
  let sansNext: string[] = []
  if (task.mode === 'line' && task.line) {
    const s = task.line.sans[sans.length]
    if (s) sansNext = [s]
  } else if (task.mode === 'traps') {
    for (const l of extending(chosen, sans)) {
      const s = l.sans[sans.length]
      if (!sansNext.some((x) => sameSan(x, s))) sansNext.push(s)
    }
  }
  return sansNext.map((san) => {
    const path = [...sans, san]
    const names = task.mode === 'line' && task.line ? [task.line.name] : lineNamesAt(task, path)
    return { san, uci: sanToUci(fen, san) ?? '', why: whyAt(task.tree, path), lineNames: names }
  })
}

/** The opponent's reply from the data, or null when there is none. */
export function opponentMove(task: QuizTask, sans: readonly string[], chosen: readonly LineMeta[]): string | null {
  if (task.mode === 'line') return task.line?.sans[sans.length] ?? null
  if (task.mode === 'traps') return extending(chosen, sans)[0]?.sans[sans.length] ?? null
  return null
}

/** How many wrong tries before the answer is revealed. */
export function maxTries(task: QuizTask, sans: readonly string[]): number {
  if (task.mode === 'positions') return 1
  if (task.mode === 'traps' && sans.length === task.startSans.length) return 1
  return 2
}

export type Turn = 'student' | 'opponent' | 'done'

export function turnAt(task: QuizTask, sans: readonly string[], fen: string, chosen: readonly LineMeta[]): Turn {
  if (isFinished(task, sans, chosen)) return 'done'
  return turnFromFen(fen) === task.side ? 'student' : 'opponent'
}

/** Other book moves in this position (line drill: moves of other lines, not counted as wrong). */
export function otherBookMove(task: QuizTask, sans: readonly string[], san: string): { san: string; lineNames: string[] } | null {
  if (task.mode !== 'line' || !task.tree) return null
  const node = findNodeByPath(task.tree, sans)
  const child = node?.children.find((c) => sameSan(c.san, san))
  if (!child) return null
  return { san: child.san, lineNames: lineNamesAt(task, [...sans, child.san]) }
}

export function whyOf(task: QuizTask, sans: readonly string[]): string {
  return whyAt(task.tree, sans)
}

// ---------------------------------------------------------------- line picker

export interface LineOptionGroup {
  openingId: string
  openingName: string
  options: { key: string; label: string }[]
}

/** Line picker groups (one per opening), lines ordered by category then file order. */
export function buildLineGroups(selected: readonly string[], fulls: Record<string, OpeningFull>): LineOptionGroup[] {
  const groups: LineOptionGroup[] = []
  for (const id of selected) {
    const f = fulls[id]
    if (!f) continue
    const lines = [...f.lines].sort((a, b) => LINE_CATEGORIES.indexOf(a.category) - LINE_CATEGORIES.indexOf(b.category))
    groups.push({
      openingId: id,
      openingName: f.name,
      options: lines.map((l) => ({ key: lineKey(id, l.id), label: `${LINE_CATEGORY_LABELS[l.category] ?? l.category} · ${l.name}` })),
    })
  }
  return groups
}
