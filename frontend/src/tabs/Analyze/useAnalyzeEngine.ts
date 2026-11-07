/**
 * Live Stockfish analysis for the Analyze tab over `/ws/analyze` (see `openAnalysisSocket`).
 *
 * One socket per mounted tab. Whenever `fen`, `multipv` or `enabled` changes, the new position is
 * sent (debounced a little so stepping quickly through a game does not hammer the engine), or the
 * engine is stopped when `enabled` is false. The socket is closed (which also stops the engine) when
 * the tab unmounts.
 *
 * `info` is only ever returned for the current `fen`, with lines beyond `multipv` dropped, so the
 * caller can draw arrows and the eval bar without worrying about stale messages.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { openAnalysisSocket, type AnalysisSocket, type SocketStatus } from '../../api/client'
import type { AnalysisInfo } from '../../api/types'

/** Delay before a position change is sent to the engine (ms). */
const SEND_DEBOUNCE_MS = 40

export interface AnalyzeEngineState {
  /** Latest engine info for the current fen (null while waiting, or when the engine is off). */
  info: AnalysisInfo | null
  /** WebSocket connection state. */
  status: SocketStatus
  /** Time (Date.now()) the current info arrived; 0 when there is none. */
  receivedAt: number
}

interface Wanted {
  fen: string
  multipv: number
  enabled: boolean
}

export function useAnalyzeEngine(fen: string, multipv: number, enabled: boolean): AnalyzeEngineState {
  const sockRef = useRef<AnalysisSocket | null>(null)
  const wantRef = useRef<Wanted>({ fen, multipv, enabled })
  const [latest, setLatest] = useState<{ info: AnalysisInfo; at: number } | null>(null)
  const [status, setStatus] = useState<SocketStatus>('connecting')

  // One socket for the lifetime of the tab.
  useEffect(() => {
    const sock = openAnalysisSocket({
      onInfo: (msg) => {
        const want = wantRef.current
        // The socket already drops infos for older positions while a position is requested; after
        // a stop it does not, so check both the fen and the toggle here as well.
        if (!want.enabled || msg.fen !== want.fen) return
        setLatest({ info: msg, at: Date.now() })
      },
      onStatus: setStatus,
    })
    sockRef.current = sock
    return () => {
      sockRef.current = null
      sock.close() // sends {stop:true} first, so the engine stops when the tab unmounts
    }
  }, [])

  // Follow the position / settings.
  useEffect(() => {
    wantRef.current = { fen, multipv, enabled }
    const sock = sockRef.current
    if (!sock) return
    if (!enabled) {
      sock.stop()
      return
    }
    const timer = setTimeout(() => sock.setPosition(fen, multipv), SEND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [fen, multipv, enabled])

  return useMemo(() => {
    const current = enabled && latest && latest.info.fen === fen ? latest : null
    const info = current
      ? { ...current.info, lines: current.info.lines.filter((l) => l.multipv <= multipv) }
      : null
    return { info, status, receivedAt: current ? current.at : 0 }
  }, [latest, enabled, fen, multipv, status])
}
