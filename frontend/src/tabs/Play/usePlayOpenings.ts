import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../../api/client'
import type { OpeningFull, OpeningSummary } from '../../api/types'

export interface PlayOpenings {
  /** Opening summaries; null while loading. */
  list: OpeningSummary[] | null
  listError: string | null
  /** Full openings (lines + tree) loaded so far, by id. */
  full: Record<string, OpeningFull>
  /** Load errors by opening id. */
  errors: Record<string, string>
  /** Retry the list and every failed opening. */
  reload: () => void
}

type LoadStatus = 'pending' | 'done' | 'error'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * Loads the opening list once and the full data of every id in `wanted` (the opening picked in the
 * new-game dialog and the opening of the current game, for its move explanations).
 */
export function usePlayOpenings(wanted: readonly string[]): PlayOpenings {
  const [list, setList] = useState<OpeningSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [full, setFull] = useState<Record<string, OpeningFull>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reloadKey, setReloadKey] = useState(0)
  /** Load status per opening id; only touched in effects and event handlers. */
  const statusRef = useRef(new Map<string, LoadStatus>())

  useEffect(() => {
    const ctrl = new AbortController()
    api
      .listOpenings(ctrl.signal)
      .then((l) => {
        setList(l)
        setListError(null)
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return
        setListError(errorText(err))
      })
    return () => ctrl.abort()
  }, [reloadKey])

  const key = [...new Set(wanted.filter(Boolean))].sort().join('\n')
  useEffect(() => {
    if (!key) return
    const status = statusRef.current
    const ctrl = new AbortController()
    const started: string[] = []
    for (const id of key.split('\n')) {
      if (status.has(id)) continue
      status.set(id, 'pending')
      started.push(id)
      api
        .getOpening(id, ctrl.signal)
        .then((o) => {
          status.set(id, 'done')
          setFull((cur) => ({ ...cur, [id]: o }))
        })
        .catch((err: unknown) => {
          if (isAbort(err)) return
          status.set(id, 'error')
          setErrors((cur) => ({ ...cur, [id]: errorText(err) }))
        })
    }
    return () => {
      if (started.length === 0) return
      ctrl.abort()
      // aborted loads are forgotten so the next run starts them again
      for (const id of started) if (status.get(id) === 'pending') status.delete(id)
    }
  }, [key, reloadKey])

  const reload = useCallback(() => {
    for (const [id, st] of statusRef.current) if (st === 'error') statusRef.current.delete(id)
    setErrors({})
    setListError(null)
    setReloadKey((k) => k + 1)
  }, [])

  return { list, listError, full, errors, reload }
}
