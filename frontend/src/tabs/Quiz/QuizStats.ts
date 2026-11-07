/**
 * Quiz progress in localStorage (key `quiz-stats-v1`, contract in ARCHITECTURE.md):
 *
 *   { [openingId]: { [nodeId]: { correct, wrong, lastSeen } } }
 *
 * `nodeId` is the SAN path (joined by spaces) of the position where the student had to move,
 * i.e. the same id as `QuizItem.id`. Line drill, position quiz and traps all write the same
 * records, so a position learnt in one mode counts in the others.
 *
 * A node is "mastered" when it has more correct than wrong answers. Mastery % of an opening is
 * mastered nodes / nodes seen.
 */
import { loadJson, saveJson } from '../../lib/storage'

export const QUIZ_STATS_KEY = 'quiz-stats-v1'

export interface QuizNodeStat {
  correct: number
  wrong: number
  /** Date.now() of the last answer. */
  lastSeen: number
}

export type QuizStats = Record<string, Record<string, QuizNodeStat>>

function isNodeStat(v: unknown): v is QuizNodeStat {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.correct === 'number' && typeof o.wrong === 'number' && typeof o.lastSeen === 'number'
}

/** Stored stats with malformed entries dropped. */
export function loadQuizStats(): QuizStats {
  const raw = loadJson<unknown>(QUIZ_STATS_KEY, {})
  const out: QuizStats = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [openingId, nodes] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) continue
    const clean: Record<string, QuizNodeStat> = {}
    for (const [nodeId, stat] of Object.entries(nodes as Record<string, unknown>)) {
      if (isNodeStat(stat)) clean[nodeId] = { correct: stat.correct, wrong: stat.wrong, lastSeen: stat.lastSeen }
    }
    out[openingId] = clean
  }
  return out
}

/** Record one answer (read-modify-write on localStorage) and return the new stats. */
export function recordQuizResult(openingId: string, nodeId: string, correct: boolean, now = Date.now()): QuizStats {
  const stats = loadQuizStats()
  const nodes = { ...(stats[openingId] ?? {}) }
  const prev = nodes[nodeId] ?? { correct: 0, wrong: 0, lastSeen: 0 }
  nodes[nodeId] = {
    correct: prev.correct + (correct ? 1 : 0),
    wrong: prev.wrong + (correct ? 0 : 1),
    lastSeen: now,
  }
  const next = { ...stats, [openingId]: nodes }
  saveJson(QUIZ_STATS_KEY, next)
  return next
}

/** Clear the stats of the given openings (all openings when `openingIds` is omitted). */
export function resetQuizStats(openingIds?: readonly string[]): QuizStats {
  if (!openingIds) {
    saveJson(QUIZ_STATS_KEY, {})
    return {}
  }
  const stats = loadQuizStats()
  for (const id of openingIds) delete stats[id]
  saveJson(QUIZ_STATS_KEY, stats)
  return stats
}

export function isMastered(stat: QuizNodeStat): boolean {
  return stat.correct > stat.wrong
}

export interface Mastery {
  seen: number
  mastered: number
  /** 0..100, 0 when nothing was seen. */
  pct: number
}

export function masteryOf(stats: QuizStats, openingId: string): Mastery {
  const nodes = Object.values(stats[openingId] ?? {})
  const mastered = nodes.filter(isMastered).length
  return { seen: nodes.length, mastered, pct: nodes.length ? Math.round((mastered / nodes.length) * 100) : 0 }
}

/**
 * Priority tier of a position: 0 = weak (seen, wrong >= correct), 1 = unseen, 2 = known.
 * The quiz asks tier 0 first, then tier 1, then tier 2.
 */
export type StatTier = 0 | 1 | 2

export function tierOf(stat: QuizNodeStat | undefined): StatTier {
  if (!stat || stat.correct + stat.wrong === 0) return 1
  return isMastered(stat) ? 2 : 0
}

/** Weighted random choice; weights <= 0 are treated as tiny. Returns null for an empty list. */
export function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, rng: () => number = Math.random): T | null {
  if (items.length === 0) return null
  const ws = items.map((it) => Math.max(1e-6, weight(it)))
  const total = ws.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= ws[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

// ---------------------------------------------------------------- session (not persisted)

export interface QuizSession {
  correct: number
  total: number
  streak: number
  best: number
}

export const EMPTY_SESSION: QuizSession = { correct: 0, total: 0, streak: 0, best: 0 }
