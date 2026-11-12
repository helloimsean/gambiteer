/**
 * Opening-book lookup for the Analyze tab.
 *
 * The opening list (`GET /api/openings`) is fetched once per mount. The full trees
 * (`GET /api/openings/{id}`) are only fetched the first time the board shows a move sequence from
 * the initial position, and are cached at module level (keyed by id + line count, so an edited
 * file is re-fetched), so switching tabs back and forth does not download them again.
 *
 * A "match" is an opening whose tree contains the exact SAN path from the start.
 */
import { useEffect, useMemo, useState } from 'react'
import * as api from '../../api/client'
import type { OpeningFull, OpeningNode, OpeningSummary } from '../../api/types'
import { deepestNodeOnPath } from '../../lib/tree'
import { t } from '../../lib/i18n'

const treeCache = new Map<string, Promise<OpeningFull>>()

function cacheKey(s: OpeningSummary): string {
  return `${s.id}@${s.lineCount}`
}

function fetchTree(s: OpeningSummary): Promise<OpeningFull> {
  const key = cacheKey(s)
  let p = treeCache.get(key)
  if (!p) {
    p = api.getOpening(s.id)
    treeCache.set(key, p)
    // forget failures so a later lookup can retry
    p.catch(() => {
      if (treeCache.get(key) === p) treeCache.delete(key)
    })
  }
  return p
}

export interface AnalyzeOpeningMatch {
  opening: OpeningFull
  /** Deepest node of this opening on the path. */
  node: OpeningNode
  /** Number of plies of the path found in this opening. */
  matched: number
}

export interface AnalyzeOpeningsState {
  /** Openings whose tree contains the whole path (best first). Empty when out of book. */
  exact: AnalyzeOpeningMatch[]
  /** When no opening contains the whole path: the opening that follows it the longest (if any). */
  partial: AnalyzeOpeningMatch | null
  /** Trees are being downloaded for the first time. */
  loading: boolean
  /** Could not load the opening list or any tree. */
  error: string | null
  /** Number of openings available. */
  count: number
}

function rank(a: AnalyzeOpeningMatch, b: AnalyzeOpeningMatch): number {
  if (a.matched !== b.matched) return b.matched - a.matched
  if (a.node.mainLine !== b.node.mainLine) return a.node.mainLine ? -1 : 1
  if (a.node.lineIds.length !== b.node.lineIds.length) return b.node.lineIds.length - a.node.lineIds.length
  return b.node.why.length - a.node.why.length
}

/**
 * @param sans SAN path from the initial position, or null when the board did not start from the
 *   initial position (then nothing is looked up).
 */
export function useAnalyzeOpenings(sans: readonly string[] | null): AnalyzeOpeningsState {
  const [summaries, setSummaries] = useState<OpeningSummary[] | null>(null)
  const [trees, setTrees] = useState<OpeningFull[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // opening list: once per mount
  useEffect(() => {
    const ctrl = new AbortController()
    api
      .listOpenings(ctrl.signal)
      .then((list) => setSummaries(list))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => ctrl.abort()
  }, [])

  const need = sans !== null && sans.length > 0

  // full trees: lazily, the first time a path needs them
  useEffect(() => {
    if (!summaries || !need || trees) return
    let cancelled = false
    void Promise.allSettled(summaries.map(fetchTree)).then((results) => {
      if (cancelled) return
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const failed = results.length - ok.length
      if (failed > 0 && ok.length === 0) setError(t('Could not load the opening trees'))
      setTrees(ok)
    })
    return () => {
      cancelled = true
    }
  }, [summaries, need, trees])

  return useMemo<AnalyzeOpeningsState>(() => {
    const base = { loading: need && !trees && !error, error, count: summaries?.length ?? 0 }
    if (!sans || sans.length === 0 || !trees) return { exact: [], partial: null, ...base }
    const found: AnalyzeOpeningMatch[] = []
    for (const opening of trees) {
      const { node, matched } = deepestNodeOnPath(opening.tree, sans)
      if (matched > 0) found.push({ opening, node, matched })
    }
    found.sort(rank)
    const exact = found.filter((m) => m.matched === sans.length)
    return { exact, partial: exact.length === 0 ? (found[0] ?? null) : null, ...base }
  }, [sans, trees, summaries, need, error])
}
