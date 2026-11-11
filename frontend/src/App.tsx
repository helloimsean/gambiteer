import { Component, useMemo, useState, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { AppProvider, TABS, useApp, type TabId, type TabInfo } from './state/AppContext'
import { EmptyState } from './components/EmptyState'
import { Icon } from './components/Icon'
import { Modal } from './components/Modal'
import { Toggle } from './components/Toggle'
import { Select } from './components/Select'
import { LANGUAGES, getLanguage, setLanguage, t, tn } from './lib/i18n'
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
    const label = TABS.find((info) => info.id === this.props.tab)?.label ?? this.props.tab
    return (
      <div className="tab-placeholder">
        <EmptyState
          icon="warning"
          title={t('The {label} tab hit an error', { label })}
          description={<code className="tab-error-text">{error.message || String(error)}</code>}
          action={
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              {t('Try again')}
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
      opts.push({ value: settings.ollamaModel, label: t('{model} (not installed)', { model: settings.ollamaModel }) })
    }
    return [{ value: '', label: t('Backend default') }, ...opts]
  }, [health, settings.ollamaModel])

  return (
    <Modal open={open} onClose={onClose} title={t('Settings')} width={460}>
      <div className="settings-grid">
        <div className="settings-row">
          <div className="settings-text">
            <span>{getLanguage() === 'en' ? 'Language' : `${t('Language')} · Language`}</span>
            <small>{t("The app and the coach's explanations")}</small>
          </div>
          <Select
            value={getLanguage()}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
            onChange={(code) => setLanguage(code)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>{t('Sounds')}</span>
            <small>{t('Move, capture and check sounds. Sacrifice voice lines: Levy Rozman (GothamChess)')}</small>
          </div>
          <Toggle checked={settings.sound} onChange={(v) => setSettings({ sound: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>{t('Coordinates')}</span>
            <small>{t('Show file and rank labels on the board')}</small>
          </div>
          <Toggle checked={settings.coordinates} onChange={(v) => setSettings({ coordinates: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>{t('Explanation model')}</span>
            <small>{t('Ollama model used by Game Review and the Learn coach')}</small>
          </div>
          <Select value={settings.ollamaModel} options={modelOptions} onChange={(v) => setSettings({ ollamaModel: v })} />
        </div>
        <div className="settings-row">
          <div className="settings-text">
            <span>{t('Review depth')}</span>
            <small>{t('Stockfish depth for Game Review')}</small>
          </div>
          <Select
            value={String(settings.defaultDepth)}
            options={[
              { value: '12', label: t('12 (fast)') },
              { value: '16', label: t('16 (default)') },
              { value: '20', label: t('20 (deep)') },
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
      <nav className="nav" aria-label={t('Main navigation')}>
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
            title={moreOpen ? t('Show less') : t('Show more')}
            aria-expanded={moreOpen}
            data-testid="nav-more"
          >
            <Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={22} />
            <span>{moreOpen ? t('Less') : t('More')}</span>
          </button>
          {moreOpen ? TABS.filter((t) => t.more).map(navItem) : null}
        </div>
        <div className="nav-footer">
          <StatusRow
            ok={stockfishOk}
            name={health?.stockfish?.name || 'Stockfish'}
            detail={health ? tn(health.openings, '{n} opening', '{n} openings') : undefined}
            title={
              health
                ? stockfishOk
                  ? `${t('{name} at {path}', { name: health.stockfish.name, path: health.stockfish.path })}\n${tn(health.openings, '{n} opening loaded', '{n} openings loaded')}`
                  : `${t('Stockfish not available')}\n${tn(health.openings, '{n} opening loaded', '{n} openings loaded')}`
                : healthError ?? t('Checking backend…')
            }
          />
          <StatusRow
            ok={ollamaOk}
            name="Ollama"
            detail={ollamaOk ? tn(ollamaModels.length, '{n} model', '{n} models') : undefined}
            title={
              health
                ? ollamaOk
                  ? t('Models: {models}', { models: ollamaModels.join(', ') })
                  : t('Ollama not reachable at localhost:11434')
                : healthError ?? t('Checking backend…')
            }
          />
          <div className="nav-footer-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              title={settings.sound ? t('Mute sounds') : t('Unmute sounds')}
              onClick={() => setSettings({ sound: !settings.sound })}
            >
              <Icon name={settings.sound ? 'sound' : 'soundOff'} size={18} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title={t('Settings')} onClick={() => setSettingsOpen(true)}>
              <Icon name="settings" size={18} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title={t('Re-check backend')} onClick={() => void refreshHealth()}>
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
