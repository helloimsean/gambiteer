import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { AppProvider, TABS, useApp, type TabId } from '@frontend/state/AppContext'
import { EmptyState } from '@frontend/components/EmptyState'
import { Icon } from '@frontend/components/Icon'
import { Modal } from '@frontend/components/Modal'
import { Select } from '@frontend/components/Select'
import { Toggle } from '@frontend/components/Toggle'
import { LearnTab } from '@frontend/tabs/Learn/LearnTab'
import { QuizTab } from '@frontend/tabs/Quiz/QuizTab'
import { AnalyzeTab } from '@frontend/tabs/Analyze/AnalyzeTab'
import { PlayTab } from '@frontend/tabs/Play/PlayTab'
import { ReviewTab } from '@frontend/tabs/Review/ReviewTab'
import { HistoryTab } from '@frontend/tabs/History/HistoryTab'
import { loadJson, saveJson } from '@frontend/lib/storage'
import { LANGUAGES, getLanguage, setLanguage, t, tn } from '@frontend/lib/i18n'
import '@frontend/App.css'
import { CoachModels } from './CoachModels'
import { native, readCoachStatus } from './native'

const INTRO_KEY = 'mobile-coach-intro-v1'

/** Per tab, the button that steps out of an inner screen when Android's back gesture is used. */
const INNER_BACK_LABEL: Partial<Record<TabId, string>> = { learn: t('All openings') }

interface BoundaryState {
  error: Error | null
}

class TabErrorBoundary extends Component<{ tab: TabId; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.tab} tab crashed]`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="tab-placeholder">
        <EmptyState
          icon="warning"
          title={t('This tab hit an error')}
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
  const { settings, setSettings, health, refreshHealth } = useApp()
  const modelOptions = useMemo(() => {
    const names = health?.ollama?.models ?? []
    return [{ value: '', label: t('Automatic') }, ...names.map((n) => ({ value: n, label: n }))]
  }, [health])

  return (
    <Modal open={open} onClose={onClose} title={t('Settings')}>
      <div className="settings-grid">
        <div className="settings-row">
          <div className="settings-text">
            <span>{getLanguage() === 'en' ? 'Language' : `${t('Language')} · Language`}</span>
            <small>{t("The app and the coach's explanations")}</small>
          </div>
          <Select value={getLanguage()} options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))} onChange={(code) => setLanguage(code)} />
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
        <div className="divider" />
        <h3>{t('AI coach')}</h3>
        <small className="muted">{t('Explanations are written by a model on this phone. Nothing leaves the device.')}</small>
        <CoachModels onChange={() => void refreshHealth()} />
        {modelOptions.length > 2 ? (
          <div className="settings-row">
            <div className="settings-text">
              <span>{t('Model in use')}</span>
            </div>
            <Select value={settings.ollamaModel} options={modelOptions} onChange={(v) => setSettings({ ollamaModel: v })} />
          </div>
        ) : null}
        <div className="divider" />
        <small className="muted">
          {health
            ? `${health.stockfish?.name || t('Stockfish unavailable')} · ${tn(health.openings, '{n} opening', '{n} openings')}`
            : t('Checking the engine…')}
        </small>
      </div>
    </Modal>
  )
}

function CoachIntro({ open, onClose, onSettings }: { open: boolean; onClose: () => void; onSettings: () => void }): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Set up the AI coach')}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Later')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onSettings}>
            {t('Choose a model')}
          </button>
        </>
      }
    >
      <p>
        {t(
          'The coach explains every move in plain language. It runs entirely on this phone, so it needs a one-time download of about {size}.',
          { size: t('{gb} GB', { gb: (3.7).toLocaleString(getLanguage()) }) },
        )}
      </p>
      <p className="muted">{t('Everything else, including Stockfish, already works without it.')}</p>
    </Modal>
  )
}

function Shell(): JSX.Element {
  const { activeTab, navigate, health, healthError } = useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(() => {
    const status = readCoachStatus()
    return status !== null && status.models.every((m) => m.state === 'absent') && !loadJson<boolean>(INTRO_KEY, false)
  })

  const history = useRef<TabId[]>([])
  const previous = useRef<TabId>(activeTab)
  const goingBack = useRef(false)

  useEffect(() => {
    if (previous.current === activeTab) return
    if (!goingBack.current) history.current.push(previous.current)
    goingBack.current = false
    previous.current = activeTab
  }, [activeTab])

  useEffect(() => {
    native?.setKeepScreenOn(activeTab === 'play')
  }, [activeTab])

  useEffect(() => {
    window.__gambiteerBack = () => {
      if (document.querySelector('.ui-modal-backdrop')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      }
      const innerLabel = INNER_BACK_LABEL[activeTab]
      if (innerLabel) {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === innerLabel)
        if (button) {
          button.click()
          return true
        }
      }
      const target = history.current.pop()
      if (target === undefined) return false
      goingBack.current = true
      navigate(target)
      return true
    }
    return () => {
      delete window.__gambiteerBack
    }
  }, [activeTab, navigate])

  const closeIntro = () => {
    setIntroOpen(false)
    saveJson(INTRO_KEY, true)
  }

  const stockfishOk = health ? Boolean(health.stockfish?.name) : healthError ? false : null
  const coachOk = health ? Boolean(health.ollama?.ok) : healthError ? false : null
  const dot = (ok: boolean | null) => `status-dot ${ok === null ? 'unknown' : ok ? 'ok' : 'bad'}`

  return (
    <div className="m-app">
      <header className="m-top">
        <img src="/logo.svg" alt="" width={26} height={26} />
        <span className="m-title">{TABS.find((t) => t.id === activeTab)?.label ?? 'Gambiteer'}</span>
        <button type="button" className="m-status" onClick={() => setSettingsOpen(true)} aria-label={t('Engine and coach status')}>
          <span className={dot(stockfishOk)} />
          <small>{t('Engine')}</small>
          <span className={dot(coachOk)} />
          <small>{t('Coach')}</small>
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label={t('Settings')} onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={22} />
        </button>
      </header>
      <main className="main m-main">
        <TabErrorBoundary key={activeTab} tab={activeTab}>
          {renderTab(activeTab)}
        </TabErrorBoundary>
      </main>
      <nav className="m-tabs" aria-label={t('Main navigation')}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`m-tab${activeTab === t.id ? ' active' : ''}`}
            aria-current={activeTab === t.id ? 'page' : undefined}
            onClick={() => navigate(t.id)}
          >
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CoachIntro
        open={introOpen}
        onClose={closeIntro}
        onSettings={() => {
          closeIntro()
          setSettingsOpen(true)
        }}
      />
    </div>
  )
}

export function MobileApp(): JSX.Element {
  return (
    <AppProvider pollHealth>
      <Shell />
    </AppProvider>
  )
}
