/**
 * LLM explanations for a finished review: one streamed explanation at a time over /ws/explain,
 * plus a sequential "explain all key moments" runner that can be stopped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { streamExplanation, type ExplanationStream } from '../../api/client'
import type { ExplainRequest } from '../../api/types'

export type ExplainStatus = 'streaming' | 'done' | 'error' | 'stopped'

export interface ExplainEntry {
  text: string
  status: ExplainStatus
  error?: string
  /** Model that produced the text ("" = backend default). */
  model?: string
}

export interface ExplainBatch {
  plies: number[]
  /** Index into `plies` of the moment being explained. */
  index: number
  current: number | null
  error?: string
}

type Outcome = 'done' | 'error' | 'cancelled'

interface Active {
  ply: number
  stream: ExplanationStream
  resolve: (o: Outcome) => void
}

export interface ReviewExplainApi {
  entries: Record<number, ExplainEntry>
  /** Ply currently streaming (single stream at a time), or null. */
  streamingPly: number | null
  batch: ExplainBatch | null
  /** Explain one ply (stops "explain all" if it is running). */
  explain: (ply: number) => void
  /** Stop the current stream (and the batch). */
  stop: () => void
  /** Explain the given plies one after another, skipping finished ones. `onStep` fires before each. */
  explainAll: (plies: number[], onStep?: (ply: number) => void) => void
}

/**
 * @param jobId   review job (explanations need it on the server)
 * @param model   Ollama model ("" = let the backend choose)
 * @param initial finished explanations to start with (from the result / saved state)
 */
export function useReviewExplain(jobId: string | null, model: string, initial: Record<number, string>): ReviewExplainApi {
  const [entries, setEntries] = useState<Record<number, ExplainEntry>>(() => toEntries(initial))
  const [streamingPly, setStreamingPly] = useState<number | null>(null)
  const [batch, setBatch] = useState<ExplainBatch | null>(null)
  const activeRef = useRef<Active | null>(null)
  const batchTokenRef = useRef(0)
  const entriesRef = useRef(entries)
  const modelRef = useRef(model)
  const initialRef = useRef(initial)
  useLayoutEffect(() => {
    entriesRef.current = entries
    modelRef.current = model
    initialRef.current = initial
  })

  // a different job starts from its own explanations
  const jobRef = useRef(jobId)
  useEffect(() => {
    if (jobRef.current === jobId) return
    jobRef.current = jobId
    batchTokenRef.current += 1
    const a = activeRef.current
    activeRef.current = null
    if (a) {
      a.stream.cancel()
      a.resolve('cancelled')
    }
    setStreamingPly(null)
    setBatch(null)
    setEntries(toEntries(initialRef.current))
  }, [jobId])

  // unmount: close the socket (StrictMode re-runs this effect, which is harmless)
  useEffect(() => {
    return () => {
      batchTokenRef.current += 1
      const a = activeRef.current
      activeRef.current = null
      if (a) {
        a.stream.cancel()
        a.resolve('cancelled')
      }
    }
  }, [])

  const cancelActive = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    activeRef.current = null
    a.stream.cancel()
    setEntries((e) => {
      const cur = e[a.ply]
      if (!cur || cur.status !== 'streaming') return e
      return { ...e, [a.ply]: { ...cur, status: 'stopped' } }
    })
    setStreamingPly(null)
    a.resolve('cancelled')
  }, [])

  const runOne = useCallback(
    (ply: number): Promise<Outcome> => {
      cancelActive()
      if (!jobId) return Promise.resolve('error')
      const m = modelRef.current
      return new Promise<Outcome>((resolve) => {
        setEntries((e) => ({ ...e, [ply]: { text: '', status: 'streaming', model: m } }))
        setStreamingPly(ply)
        const req: ExplainRequest = m ? { jobId, ply, model: m } : { jobId, ply }
        const settle = (o: Outcome) => {
          if (activeRef.current?.ply === ply) activeRef.current = null
          setStreamingPly((p) => (p === ply ? null : p))
          resolve(o)
        }
        const stream = streamExplanation(req, {
          onToken: (t) =>
            setEntries((e) => {
              const cur = e[ply]
              return { ...e, [ply]: { text: (cur?.text ?? '') + t, status: 'streaming', model: m } }
            }),
          onDone: (full) => {
            setEntries((e) => ({ ...e, [ply]: { text: (full || e[ply]?.text || '').trim(), status: 'done', model: m } }))
            settle('done')
          },
          onError: (msg) => {
            setEntries((e) => ({ ...e, [ply]: { text: e[ply]?.text ?? '', status: 'error', error: msg, model: m } }))
            settle('error')
          },
        })
        activeRef.current = { ply, stream, resolve }
      })
    },
    [jobId, cancelActive],
  )

  const stop = useCallback(() => {
    batchTokenRef.current += 1
    setBatch(null)
    cancelActive()
  }, [cancelActive])

  const explain = useCallback(
    (ply: number) => {
      batchTokenRef.current += 1
      setBatch(null)
      void runOne(ply)
    },
    [runOne],
  )

  const explainAll = useCallback(
    (plies: number[], onStep?: (ply: number) => void) => {
      const token = ++batchTokenRef.current
      const todo = plies.filter((p) => entriesRef.current[p]?.status !== 'done')
      if (todo.length === 0) {
        setBatch(null)
        return
      }
      const run = async () => {
        for (let i = 0; i < todo.length; i++) {
          if (batchTokenRef.current !== token) return
          const ply = todo[i]
          setBatch({ plies: todo, index: i, current: ply })
          onStep?.(ply)
          const outcome = await runOne(ply)
          if (batchTokenRef.current !== token) return
          if (outcome === 'cancelled') break
          if (outcome === 'error') {
            // Ollama down / model missing: every further request would fail the same way
            setBatch(null)
            return
          }
        }
        if (batchTokenRef.current === token) setBatch(null)
      }
      void run()
    },
    [runOne],
  )

  return { entries, streamingPly, batch, explain, stop, explainAll }
}

function toEntries(initial: Record<number, string>): Record<number, ExplainEntry> {
  const out: Record<number, ExplainEntry> = {}
  for (const [k, v] of Object.entries(initial)) {
    if (v && v.trim()) out[Number(k)] = { text: v, status: 'done' }
  }
  return out
}
