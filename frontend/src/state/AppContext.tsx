/**
 * App-wide state shared by the shell and the tabs.
 *
 *   const { navigate, settings, health, analyzeRequest, clearRequest } = useApp()
 *
 * Cross-tab hand-offs ("Analyze this position", "Review this game", "Quiz this opening") go
 * through `navigate(tab, payload)`. The payload is stored as `<tab>Request` until the target tab
 * consumes it and calls `clearRequest(tab)`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { getHealth } from '../api/client'
import type { Health, Players, Side } from '../api/types'
import type { IconName } from '../components/Icon'
import { t } from '../lib/i18n'
import { setMuted } from '../lib/sounds'
import { loadJson, saveJson } from '../lib/storage'

// ---------------------------------------------------------------- tabs

export type TabId = 'learn' | 'quiz' | 'analyze' | 'play' | 'review' | 'history'

export interface TabInfo {
  id: TabId
  label: string
  icon: IconName
  description: string
  /** Listed under the sidebar's More / Less toggle. */
  more?: boolean
}

export const TABS: readonly TabInfo[] = [
  { id: 'learn', label: t('Learn'), icon: 'learn', description: t('Browse your opening repertoire move by move, with the reason behind every move.') },
  { id: 'quiz', label: t('Quiz'), icon: 'quiz', description: t('Drill lines, guess positions and spot traps. Weak spots come back more often.') },
  { id: 'analyze', label: t('Analyze'), icon: 'analyze', description: t('Free analysis board with live Stockfish 19 lines and an eval bar.') },
  { id: 'play', label: t('Play'), icon: 'play', description: t('Play against Stockfish 19 or the human-like Maia at a chosen Elo, optionally starting from an opening line.') },
  { id: 'review', label: t('Review'), icon: 'review', description: t('Game review with move classifications, accuracy and LLM explanations.') },
  { id: 'history', label: t('History'), icon: 'history', description: t('Every game you finished against the bots, with the Elo and your accuracy.'), more: true },
]

// ---------------------------------------------------------------- cross-tab requests

/** Open the Analyze tab at a position (fen) or after a move sequence (sans, from the start or startFen). */
export interface AnalyzeRequestPayload {
  fen?: string
  sans?: string[]
  startFen?: string
}

/** Open the Review setup on this game (the one just played, or one from History). */
export type ReviewRequestPayload = LastGame

/** Quiz an opening (optionally a specific line / mode). */
export interface QuizRequestPayload {
  openingId: string
  lineId?: string
  mode?: 'line' | 'positions' | 'traps'
}

/** Open an opening in Learn, optionally at a node (SAN path id). */
export interface LearnRequestPayload {
  openingId: string
  nodeId?: string
}

/** Start a game from an opening line and/or as a colour. */
export interface PlayRequestPayload {
  openingId?: string
  lineId?: string
  color?: Side
}

export interface NavigatePayloads {
  analyze: AnalyzeRequestPayload
  review: ReviewRequestPayload
  quiz: QuizRequestPayload
  learn: LearnRequestPayload
  play: PlayRequestPayload
  history: never
}

// ---------------------------------------------------------------- settings / last game

export interface AppSettings {
  /** Board sounds. */
  sound: boolean
  /** Board coordinates. */
  coordinates: boolean
  /** Ollama model for explanations; "" = let the backend pick its default. */
  ollamaModel: string
  /** Default review depth (12 fast / 16 default / 20 deep). */
  defaultDepth: number
  /** Game Review's advanced Stockfish settings. */
  reviewEngine: ReviewEngineChoice
}

/** Each null means the backend's own setting (the phone's differ from the PC's). */
export interface ReviewEngineChoice {
  threads: number | null
  hashMb: number | null
  /** null: no time limit per move. */
  moveTimeMs: number | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  sound: true,
  coordinates: true,
  ollamaModel: '',
  defaultDepth: 16,
  reviewEngine: { threads: null, hashMb: null, moveTimeMs: null },
}

export const SETTINGS_KEY = 'settings-v1'
export const LAST_GAME_KEY = 'last-game-v1'

/** The most recent game played in the Play tab (or imported), ready for Review. */
export interface LastGame {
  sans: string[]
  startFen?: string
  players?: Players
  /** "1-0" | "0-1" | "1/2-1/2" | "*" */
  result?: string
  /** Why the game ended (free text: "checkmate", "resigned", ...). */
  reason?: string
  /** Date.now() when the game ended. */
  playedAt: number
}

// ---------------------------------------------------------------- context

export interface AppContextValue {
  activeTab: TabId
  /** Switch tab, optionally handing the target tab a request payload. */
  navigate: <T extends TabId>(tab: T, payload?: NavigatePayloads[T]) => void

  lastGame: LastGame | null
  setLastGame: (game: LastGame | null) => void

  analyzeRequest: AnalyzeRequestPayload | null
  reviewRequest: ReviewRequestPayload | null
  quizRequest: QuizRequestPayload | null
  learnRequest: LearnRequestPayload | null
  playRequest: PlayRequestPayload | null
  /**
   * Tabs call this once they have consumed their request. Without an argument it clears the
   * request of the currently active tab (which is the caller in practice).
   */
  clearRequest: (tab?: TabId) => void

  settings: AppSettings
  /** Merge a partial update into the settings (persisted to localStorage). */
  setSettings: (patch: Partial<AppSettings>) => void

  /** Backend health; null until the first response. */
  health: Health | null
  /** Error message when the backend is unreachable. */
  healthError: string | null
  /** Re-fetch /api/health; resolves to the new value (null on error). */
  refreshHealth: () => Promise<Health | null>
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}

/** Stored settings merged over the defaults; fields with the wrong type are ignored. */
function loadSettings(): AppSettings {
  const stored = loadJson<Record<string, unknown> | null>(SETTINGS_KEY, null)
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  if (!stored || typeof stored !== 'object') return out
  if (typeof stored.sound === 'boolean') out.sound = stored.sound
  if (typeof stored.coordinates === 'boolean') out.coordinates = stored.coordinates
  if (typeof stored.ollamaModel === 'string') out.ollamaModel = stored.ollamaModel
  if (typeof stored.defaultDepth === 'number' && stored.defaultDepth >= 12 && stored.defaultDepth <= 24) {
    out.defaultDepth = stored.defaultDepth
  }
  if (stored.reviewEngine && typeof stored.reviewEngine === 'object') {
    const engine = stored.reviewEngine as Record<string, unknown>
    const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
    out.reviewEngine = { threads: whole(engine.threads), hashMb: whole(engine.hashMb), moveTimeMs: whole(engine.moveTimeMs) }
  }
  return out
}

export interface AppProviderProps {
  children: ReactNode
  initialTab?: TabId
  /** Set false to skip the health poll (tests, playground). Default true. */
  pollHealth?: boolean
}

export function AppProvider({ children, initialTab = 'learn', pollHealth = true }: AppProviderProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab)
  const [lastGame, setLastGameState] = useState<LastGame | null>(() => loadJson<LastGame | null>(LAST_GAME_KEY, null))
  const [analyzeRequest, setAnalyzeRequest] = useState<AnalyzeRequestPayload | null>(null)
  const [reviewRequest, setReviewRequest] = useState<ReviewRequestPayload | null>(null)
  const [quizRequest, setQuizRequest] = useState<QuizRequestPayload | null>(null)
  const [learnRequest, setLearnRequest] = useState<LearnRequestPayload | null>(null)
  const [playRequest, setPlayRequest] = useState<PlayRequestPayload | null>(null)
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  // sound setting -> global mute flag
  useEffect(() => {
    setMuted(!settings.sound)
  }, [settings.sound])

  const setSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState((cur) => {
      const next = { ...cur, ...patch }
      saveJson(SETTINGS_KEY, next)
      return next
    })
  }, [])

  const setLastGame = useCallback((game: LastGame | null) => {
    setLastGameState(game)
    saveJson(LAST_GAME_KEY, game)
  }, [])

  // Mirrors activeTab for clearRequest(). Written synchronously in navigate() because the target
  // tab's mount effect (which calls clearRequest) runs before any effect of this provider.
  const activeTabRef = useRef<TabId>(initialTab)

  const navigate = useCallback(<T extends TabId>(tab: T, payload?: NavigatePayloads[T]) => {
    activeTabRef.current = tab
    if (payload) {
      switch (tab) {
        case 'analyze':
          setAnalyzeRequest(payload as AnalyzeRequestPayload)
          break
        case 'review':
          setReviewRequest(payload as ReviewRequestPayload)
          break
        case 'quiz':
          setQuizRequest(payload as QuizRequestPayload)
          break
        case 'learn':
          setLearnRequest(payload as LearnRequestPayload)
          break
        case 'play':
          setPlayRequest(payload as PlayRequestPayload)
          break
      }
    }
    setActiveTab(tab)
  }, [])

  const clearRequest = useCallback((tab?: TabId) => {
    switch (tab ?? activeTabRef.current) {
      case 'analyze':
        setAnalyzeRequest(null)
        break
      case 'review':
        setReviewRequest(null)
        break
      case 'quiz':
        setQuizRequest(null)
        break
      case 'learn':
        setLearnRequest(null)
        break
      case 'play':
        setPlayRequest(null)
        break
    }
  }, [])

  const refreshHealth = useCallback(async (): Promise<Health | null> => {
    try {
      const h = await getHealth()
      setHealth(h)
      setHealthError(null)
      return h
    } catch (err) {
      setHealth(null)
      setHealthError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  // Poll health once at start; keep retrying every 10 s only while the backend is unreachable
  // (so starting the backend after the frontend turns the status dots green by itself).
  useEffect(() => {
    if (!pollHealth) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const h = await refreshHealth()
      if (cancelled) return
      if (!h) timer = setTimeout(tick, 10_000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pollHealth, refreshHealth])

  const value = useMemo<AppContextValue>(
    () => ({
      activeTab,
      navigate,
      lastGame,
      setLastGame,
      analyzeRequest,
      reviewRequest,
      quizRequest,
      learnRequest,
      playRequest,
      clearRequest,
      settings,
      setSettings,
      health,
      healthError,
      refreshHealth,
    }),
    [
      activeTab,
      navigate,
      lastGame,
      setLastGame,
      analyzeRequest,
      reviewRequest,
      quizRequest,
      learnRequest,
      playRequest,
      clearRequest,
      settings,
      setSettings,
      health,
      healthError,
      refreshHealth,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
