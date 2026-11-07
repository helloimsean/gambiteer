/**
 * Typed HTTP + WebSocket client for the FastAPI backend (see ARCHITECTURE.md).
 *
 * All paths are relative so they work both through the Vite dev proxy and when
 * the backend serves the built frontend itself.
 */
import type {
  AnalysisCommand,
  AnalysisInfo,
  AnalyzeRequest,
  AnalyzeResponse,
  BotMoveRequest,
  BotMoveResponse,
  CoachEvent,
  CoachMove,
  CoachRequest,
  CoachResponse,
  ExplainEvent,
  ExplainRequest,
  ExplainResponse,
  Health,
  OllamaModelsResponse,
  OpeningFull,
  OpeningSummary,
  PgnParseResponse,
  QuizItem,
  QuizMode,
  ReviewJob,
  ReviewRequest,
  ReviewStartResponse,
} from './types'

export const API_BASE = '/api'

/** Thrown by every HTTP helper when the backend answers with a non-2xx status or is unreachable. */
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

function extractDetail(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail
    if (typeof d === 'string') return d
    try {
      return JSON.stringify(d)
    } catch {
      return undefined
    }
  }
  return undefined
}

async function request<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'Backend unreachable (is uvicorn running on port 8000?)', err)
  }
  if (!res.ok) {
    let body: unknown = undefined
    try {
      body = await res.json()
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, extractDetail(body) ?? `${res.status} ${res.statusText}`, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), signal })
}

// ---------------------------------------------------------------- HTTP endpoints

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request<Health>('/health', { signal })
}

export function listOpenings(signal?: AbortSignal): Promise<OpeningSummary[]> {
  return request<OpeningSummary[]>('/openings', { signal })
}

export function getOpening(id: string, signal?: AbortSignal): Promise<OpeningFull> {
  return request<OpeningFull>(`/openings/${encodeURIComponent(id)}`, { signal })
}

export function getQuiz(
  openingId: string,
  mode: QuizMode = 'positions',
  limit = 50,
  signal?: AbortSignal,
): Promise<QuizItem[]> {
  const q = new URLSearchParams({ mode, limit: String(limit) })
  return request<QuizItem[]>(`/openings/${encodeURIComponent(openingId)}/quiz?${q}`, { signal })
}

/** One-shot analysis (used for hints and "analyze once"). Prefer the WebSocket for live analysis. */
export function analyzeOnce(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse> {
  return post<AnalyzeResponse>('/analyze', req, signal)
}

export function botMove(req: BotMoveRequest, signal?: AbortSignal): Promise<BotMoveResponse> {
  return post<BotMoveResponse>('/bot/move', req, signal)
}

export function parsePgn(pgn: string, signal?: AbortSignal): Promise<PgnParseResponse> {
  return post<PgnParseResponse>('/pgn/parse', { pgn }, signal)
}

export function startReview(req: ReviewRequest, signal?: AbortSignal): Promise<ReviewStartResponse> {
  return post<ReviewStartResponse>('/review', req, signal)
}

export function getReview(jobId: string, signal?: AbortSignal): Promise<ReviewJob> {
  return request<ReviewJob>(`/review/${encodeURIComponent(jobId)}`, { signal })
}

export function listOllamaModels(signal?: AbortSignal): Promise<OllamaModelsResponse> {
  return request<OllamaModelsResponse>('/ollama/models', { signal })
}

/** Non-streaming explanation. For a live token stream use {@link streamExplanation}. */
export function explainOnce(req: ExplainRequest, signal?: AbortSignal): Promise<ExplainResponse> {
  return post<ExplainResponse>('/explain', req, signal)
}

/**
 * One-shot coach verdict (+ explanation unless `explain: false`) for a single move. For practice
 * (many moves, streamed text) prefer {@link openCoachSocket}. 400 = bad FEN / illegal move,
 * 503 = no Stockfish; an Ollama failure is still a 200 with `text: ""` and `coachError`.
 */
export function requestCoach(req: CoachRequest, signal?: AbortSignal): Promise<CoachResponse> {
  return post<CoachResponse>('/coach/move', req, signal)
}

// ---------------------------------------------------------------- WebSockets

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

export type SocketStatus = 'connecting' | 'open' | 'closed' | 'reconnecting'

export interface AnalysisSocketOptions {
  onInfo: (info: AnalysisInfo) => void
  onStatus?: (status: SocketStatus) => void
  onError?: (err: Event) => void
}

export interface AnalysisSocket {
  /** Start (or switch) live analysis. Safe to call rapidly; the last call wins. */
  setPosition(fen: string, multipv?: number): void
  /** Ask the engine to stop; the socket stays open. */
  stop(): void
  /** Close for good (no reconnect). */
  close(): void
  readonly status: SocketStatus
}

/**
 * Persistent connection to `/ws/analyze` with auto-reconnect (exponential backoff,
 * capped at 10 s). If a position was requested before a reconnect it is re-sent,
 * so the caller never has to think about connection state.
 *
 * Infos for a fen other than the most recently requested one are dropped, which
 * avoids flicker when the user moves quickly.
 */
export function openAnalysisSocket(opts: AnalysisSocketOptions): AnalysisSocket {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: { fen: string; multipv: number } | null = null
  let status: SocketStatus = 'connecting'

  const setStatus = (s: SocketStatus) => {
    if (status === s && s !== 'connecting') return
    status = s
    opts.onStatus?.(s)
  }

  const send = (msg: AnalysisCommand) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const connect = () => {
    if (closed) return
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    const sock = new WebSocket(wsUrl('/ws/analyze'))
    ws = sock
    sock.onopen = () => {
      attempt = 0
      setStatus('open')
      if (last) sock.send(JSON.stringify(last))
    }
    sock.onmessage = (ev) => {
      let data: unknown
      try {
        data = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (!data || typeof data !== 'object') return
      const info = data as Partial<AnalysisInfo>
      if (info.type !== 'info' || !Array.isArray(info.lines)) return
      if (last && info.fen && info.fen !== last.fen) return // stale
      opts.onInfo(info as AnalysisInfo)
    }
    sock.onerror = (ev) => opts.onError?.(ev)
    sock.onclose = () => {
      if (ws === sock) ws = null
      if (closed) {
        setStatus('closed')
        return
      }
      attempt += 1
      const delay = Math.min(10_000, 300 * 2 ** Math.min(attempt, 5))
      setStatus('reconnecting')
      timer = setTimeout(connect, delay)
    }
  }

  connect()

  return {
    setPosition(fen, multipv = 3) {
      last = { fen, multipv }
      send(last)
    },
    stop() {
      last = null
      send({ stop: true })
    },
    close() {
      closed = true
      last = null
      if (timer) clearTimeout(timer)
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ stop: true }))
        } catch {
          /* ignore */
        }
        ws.close()
      }
      setStatus('closed')
    },
    get status() {
      return status
    },
  }
}

export interface ReviewSocket {
  close(): void
}

/**
 * Subscribe to `/ws/review/{jobId}`. The server pushes `ReviewJob` snapshots and
 * closes the socket when the job is done or failed. `onClose` fires exactly once,
 * after which the caller should GET /api/review/{jobId} if it has not yet seen a
 * terminal snapshot (the socket may close before the last snapshot is received).
 */
export function openReviewSocket(
  jobId: string,
  onSnapshot: (job: ReviewJob) => void,
  onClose?: (ev: { clean: boolean }) => void,
): ReviewSocket {
  const sock = new WebSocket(wsUrl(`/ws/review/${encodeURIComponent(jobId)}`))
  let closedByUs = false
  let notified = false
  const notify = (clean: boolean) => {
    if (notified) return
    notified = true
    onClose?.({ clean })
  }
  sock.onmessage = (ev) => {
    try {
      const data = JSON.parse(String(ev.data)) as ReviewJob
      if (data && typeof data === 'object' && 'status' in data) onSnapshot(data)
    } catch {
      /* ignore malformed */
    }
  }
  sock.onclose = (ev) => notify(closedByUs || ev.wasClean)
  sock.onerror = () => notify(false)
  return {
    close() {
      closedByUs = true
      sock.close()
    },
  }
}

export interface CoachSocketHandlers {
  /** Engine verdict for a request (always the first reply, also before an explain error). */
  onAnalysis: (requestId: string, move: CoachMove) => void
  onToken: (requestId: string, text: string) => void
  /** Last reply of a request: the full explanation ("" when explain was false). */
  onDone: (requestId: string, text: string) => void
  /** Last reply of a failed request. `requestId` is "" when the server could not read it. */
  onError: (requestId: string, stage: 'analysis' | 'explain', message: string) => void
  /** The socket closed without `close()` being called (backend down / restarted). Fires once. */
  onClose?: () => void
}

export interface CoachSocket {
  /** Send a request (queued until the socket is open). Ignored after `close()`. */
  send(req: CoachRequest): void
  /** Close for good. Pending requests are dropped on the server; no handler fires afterwards. */
  close(): void
  /** True after `close()` or once the connection was lost. */
  readonly closed: boolean
}

/**
 * Connection to `/ws/coach`: several requests may be in flight, every reply carries its
 * `requestId`. Verdicts come back in request order without waiting for older explanations;
 * explanations stream one at a time, also in request order. There is no cancel message: to drop
 * queued work, `close()` this socket and open a new one. No auto-reconnect (pending replies would
 * be lost anyway); open a new socket on the next request instead.
 */
export function openCoachSocket(handlers: CoachSocketHandlers): CoachSocket {
  const sock = new WebSocket(wsUrl('/ws/coach'))
  const queue: string[] = []
  let closed = false
  let notified = false

  const lost = () => {
    closed = true
    queue.length = 0
    if (notified) return
    notified = true
    handlers.onClose?.()
  }

  sock.onopen = () => {
    if (closed) {
      // close() was called while connecting (closing then would log a console error)
      sock.close()
      return
    }
    for (const msg of queue.splice(0)) sock.send(msg)
  }
  sock.onmessage = (ev) => {
    if (closed) return
    let data: CoachEvent
    try {
      data = JSON.parse(String(ev.data)) as CoachEvent
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    const id = typeof data.requestId === 'string' ? data.requestId : ''
    switch (data.type) {
      case 'analysis':
        handlers.onAnalysis(id, data.move)
        break
      case 'token':
        handlers.onToken(id, data.text)
        break
      case 'done':
        handlers.onDone(id, data.text ?? '')
        break
      case 'error':
        handlers.onError(id, data.stage === 'explain' ? 'explain' : 'analysis', data.message ?? 'error')
        break
    }
  }
  sock.onerror = () => {
    if (!closed) lost()
  }
  sock.onclose = () => {
    if (!closed) lost()
  }

  return {
    send(req) {
      if (closed) return
      const msg = JSON.stringify(req)
      if (sock.readyState === WebSocket.OPEN) sock.send(msg)
      else queue.push(msg)
    },
    close() {
      closed = true
      notified = true
      queue.length = 0
      if (sock.readyState === WebSocket.CONNECTING) return // closed in onopen
      try {
        sock.close()
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return closed
    },
  }
}

export interface ExplanationHandlers {
  onToken: (text: string) => void
  /** Full text of the explanation. */
  onDone: (text: string) => void
  onError: (message: string) => void
}

export interface ExplanationStream {
  cancel(): void
}

/**
 * Stream an LLM explanation over `/ws/explain`. Opens a socket, sends the request,
 * forwards tokens, and closes when done. `cancel()` closes the socket early (the
 * handlers are not called afterwards).
 */
export function streamExplanation(req: ExplainRequest, handlers: ExplanationHandlers): ExplanationStream {
  const sock = new WebSocket(wsUrl('/ws/explain'))
  let finished = false
  let acc = ''

  const finish = (fn: () => void) => {
    if (finished) return
    finished = true
    fn()
    try {
      sock.close()
    } catch {
      /* ignore */
    }
  }

  sock.onopen = () => sock.send(JSON.stringify(req))
  sock.onmessage = (ev) => {
    if (finished) return
    let data: ExplainEvent
    try {
      data = JSON.parse(String(ev.data)) as ExplainEvent
    } catch {
      return
    }
    switch (data.type) {
      case 'token':
        acc += data.text
        handlers.onToken(data.text)
        break
      case 'done':
        finish(() => handlers.onDone(data.text || acc))
        break
      case 'error':
        finish(() => handlers.onError(data.message))
        break
    }
  }
  sock.onerror = () => finish(() => handlers.onError('Explanation socket error'))
  sock.onclose = () => {
    if (!finished) finish(() => (acc ? handlers.onDone(acc) : handlers.onError('Explanation socket closed')))
  }
  return {
    cancel() {
      finished = true
      try {
        sock.close()
      } catch {
        /* ignore */
      }
    },
  }
}
