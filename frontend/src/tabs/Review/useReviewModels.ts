/** Installed Ollama models (GET /api/ollama/models) with a retry, for the Review tab. */
import { useCallback, useEffect, useState } from 'react'
import { listOllamaModels } from '../../api/client'
import type { OllamaModel } from '../../api/types'

export interface ReviewModelsState {
  status: 'loading' | 'ok' | 'down'
  models: OllamaModel[]
  /** Backend default ("" when Ollama is down). */
  defaultModel: string
  /** Error text when the request itself failed (backend unreachable). */
  error?: string
}

export function useReviewModels(): ReviewModelsState & { retry: () => void } {
  const [state, setState] = useState<ReviewModelsState>({ status: 'loading', models: [], defaultModel: '' })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const ctl = new AbortController()
    listOllamaModels(ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return
        setState({ status: res.models.length > 0 ? 'ok' : 'down', models: res.models, defaultModel: res.default })
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setState({ status: 'down', models: [], defaultModel: '', error: err instanceof Error ? err.message : String(err) })
      })
    return () => ctl.abort()
  }, [tick])

  const retry = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }))
    setTick((t) => t + 1)
  }, [])

  return { ...state, retry }
}
