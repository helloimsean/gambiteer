import { Component, useMemo, useState, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { AppProvider, TABS, useApp, type TabId, type TabInfo } from './state/AppContext'
import { EmptyState } from './components/EmptyState'
import { Icon } from './components/Icon'
import { Modal } from './components/Modal'
import { Toggle } from './components/Toggle'
import { Select } from './components/Select'
import { LearnTab } from './tabs/Learn/LearnTab'
import { QuizTab } from './tabs/Quiz/QuizTab'
import { AnalyzeTab } from './tabs/Analyze/AnalyzeTab'
import { PlayTab } from './tabs/Play/PlayTab'
import { ReviewTab } from './tabs/Review/ReviewTab'
import { HistoryTab } from './tabs/History/HistoryTab'
import { DevPlayground } from './dev/DevPlayground'
import { loadJson, saveJson } from './lib/storage'
import './App.css'

const NAV_MORE_KEY = 'nav-more-open-v1'

interface TabBoundaryProps {
  tab: TabId
  children: ReactNode
}
interface TabBoundaryState {
  error: Error | null
}

/**
 * Keeps a crashing tab from taking the whole shell down: shows the error with a retry button.
 * Keyed by tab in the shell, so switching tabs always starts with a clean boundary.
 */
class TabErrorBoundary extends Component<TabBoundaryProps, TabBoundaryState> {
  state: TabBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): TabBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.tab} tab crashed]`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const label = TABS.find((t) => t.id === this.props.tab)?.label ?? this.props.tab
    return (
      <div className="tab-placeholder">
        <EmptyState
          icon="warning"
          title={`The ${label} tab hit an error`}
          description={<code className="tab-error-text">{error.message || String(error)}</code>}
          action={
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          }
        />
      </div>
    )
  }
}

function renderTab(tab: TabId): JSX.Element {
  switch (tab) {
    case 'learn':
      return <LearnTab />
    case 'quiz':
      return <QuizTab />
    case 'analyze':
      return <AnalyzeTab />
    case 'play':
      return <PlayTab />
    case 'review':
      return <ReviewTab />
    case 'history':
      return <HistoryTab />
  }
}

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const { settings, setSettings, health } = useApp()
  const modelOptions = useMemo(() => {
    const names = health?.ollama?.models ?? []
    const opts = names.map((n) => ({ value: n, label: n }))
    if (settings.ollamaModel && !names.includes(settings.ollamaModel)) {
      opts.push({ value: settings.ollamaModel, label: `${settings.ollamaModel} (not installed)` })
    }
    return [{ value: '', label: 'Backend default' }, ...opts]
  }, [health, settings.ollamaModel])

  return (
    <Modal open={open} onClose={onClose} title="Settings" width={460}>
      <div className="settings-grid">
        <div className="settings-row">
          <div className="settings-text">
            <span>Sounds</span>
            <small>Move, capture and check sounds. Sacrifice voice lines: Levy Rozman (GothamChess)</small>
          </div>
          <Toggle checked={settings.sound} onChange={(v) => setSettings({ sound: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>Coordinates</span>
            <small>Show file and rank labels on the board</small>
          </div>
          <Toggle checked={settings.coordinates} onChange={(v) => setSettings({ coordinates: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>Explanation model</span>
            <small>Ollama model used by Game Review and the Learn coach</small>
          </div>
          <Select value={settings.ollamaModel} options={modelOptions} onChange={(v) => setSettings({ ollamaModel: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>Review depth</span>
            <small>Stockfish depth for Game Review</small>
          </div>
          <Select
            value={String(settings.defaultDepth)}
            options={[
              { value: '12', label: '12 (fast)' },
              { value: '16', label: '16 (default)' },
              { value: '20', label: '20 (deep)' },
            ]}
            onChange={(v) => setSettings({ defaultDepth: Number(v) })}
          />
        </div>
      </div>
    </Modal>
  )
}

function StatusRow({ ok, name, detail, title }: { ok: boolean | null; name: string; detail?: string; title: string }): JSX.Element {
  const cls = ok === null ? 'unknown' : ok ? 'ok' : 'bad'
  return (
    <div className="nav-status" title={title}>
      <span className={`status-dot ${cls}`} />
      <span className="status-name">{name}</span>
      {detail ? <span className="status-detail">{detail}</span> : null}
    </div>
  )
}

function Shell(): JSX.Element {
  const { activeTab, navigate, health, healthError, settings, setSettings, refreshHealth } = useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(() => loadJson<boolean>(NAV_MORE_KEY, false) === true)

  const toggleMore = () => {
    setMoreOpen(!moreOpen)
    saveJson(NAV_MORE_KEY, !moreOpen)
  }

  const navItem = (t: TabInfo) => (
    <button
      key={t.id}
      type="button"
      className={`nav-item${activeTab === t.id ? ' active' : ''}`}
      onClick={() => navigate(t.id)}
      title={t.description}
      aria-current={activeTab === t.id ? 'page' : undefined}
    >
      <Icon name={t.icon} size={22} />
      <span>{t.label}</span>
    </button>
  )

  // null = unknown (first request pending), false = backend unreachable or that component is down
  const stockfishOk = health ? Boolean(health.stockfish?.name) : healthError ? false : null
  const ollamaOk = health ? Boolean(health.ollama?.ok) : healthError ? false : null
  const ollamaModels = health?.ollama?.models ?? []

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">
          <img className="nav-logo" src="/logo.svg" alt="" width={32} height={32} />
          <span>Gambiteer</span>
        </div>
        <div className="nav-items">
          {TABS.filter((t) => !t.more).map(navItem)}
          <button
            type="button"
            className="nav-item nav-more"
            onClick={toggleMore}
            title={moreOpen ? 'Show less' : 'Show more'}
            aria-expanded={moreOpen}
            data-testid="nav-more"
          >
            <Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={22} />
            <span>{moreOpen ? 'Less' : 'More'}</span>
          </button>
          {moreOpen ? TABS.filter((t) => t.more).map(navItem) : null}
        </div>
        <div className="nav-footer">
          <StatusRow
            ok={stockfishOk}
            name={health?.stockfish?.name || 'Stockfish'}
            detail={health ? `${health.openings} openings` : undefined}
            title={
              health
                ? stockfishOk
                  ? `${health.stockfish.name} at ${health.stockfish.path}\n${health.openings} openings loaded`
                  : `Stockfish not available\n${health.openings} openings loaded`
                : healthError ?? 'Checking backend…'
            }
          />
          <StatusRow
            ok={ollamaOk}
            name="Ollama"
            detail={ollamaOk ? `${ollamaModels.length} models` : undefined}
            title={
              health
                ? ollamaOk
                  ? `Models: ${ollamaModels.join(', ')}`
                  : 'Ollama not reachable at localhost:11434'
                : healthError ?? 'Checking backend…'
            }
          />
          <div className="nav-footer-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              title={settings.sound ? 'Mute sounds' : 'Unmute sounds'}
              onClick={() => setSettings({ sound: !settings.sound })}
            >
              <Icon name={settings.sound ? 'sound' : 'soundOff'} size={18} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Settings" onClick={() => setSettingsOpen(true)}>
              <Icon name="settings" size={18} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Re-check backend" onClick={() => void refreshHealth()}>
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        <TabErrorBoundary key={activeTab} tab={activeTab}>
          {renderTab(activeTab)}
        </TabErrorBoundary>
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

/** Root component. `?dev=1` shows the shared-component playground instead of the app. */
export function App(): JSX.Element {
  const isDev = useMemo(() => new URLSearchParams(window.location.search).get('dev') === '1', [])
  return <AppProvider pollHealth={!isDev}>{isDev ? <DevPlayground /> : <Shell />}</AppProvider>
}
