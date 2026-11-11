import { useEffect, useRef, useState, type JSX } from 'react'
import * as api from '../../api/client'
import { ApiError } from '../../api/client'
import type { OpeningFull } from '../../api/types'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import { t } from '../../lib/i18n'
import { loadJson, removeKey } from '../../lib/storage'
import { useApp } from '../../state/AppContext'
import { LearnGallery } from './LearnGallery'
import { LearnOpeningView, type LearnInitial } from './LearnOpeningView'
import { LEARN_LAST_KEY, type LearnLastState } from './learnUtils'
import './LearnTab.css'

interface Selection {
  openingId: string
  initial: LearnInitial
  /** Restored from localStorage (a failed load then falls back to the gallery silently). */
  restored: boolean
}

function restoreLast(): Selection | null {
  const last = loadJson<LearnLastState | null>(LEARN_LAST_KEY, null)
  if (!last || typeof last.openingId !== 'string' || !last.openingId) return null
  return {
    openingId: last.openingId,
    initial: { nodeId: typeof last.nodeId === 'string' ? last.nodeId : undefined, lineId: last.lineId ?? null, token: 0 },
    restored: true,
  }
}

/**
 * Learn tab: opening gallery, then the opening view (board + Tree / Lines / Ideas).
 * Consumes `learnRequest` ({ openingId, nodeId? }) to open an opening directly; otherwise it
 * reopens the opening and position the student last looked at.
 */
export function LearnTab(): JSX.Element {
  const { learnRequest, clearRequest } = useApp()
  const [sel, setSel] = useState<Selection | null>(() =>
    learnRequest
      ? { openingId: learnRequest.openingId, initial: { nodeId: learnRequest.nodeId, token: 1 }, restored: false }
      : restoreLast(),
  )
  const [opening, setOpening] = useState<OpeningFull | null>(null)
  const [reload, setReload] = useState(0)
  /** Load error, tagged with the request it belongs to (so a new request never shows a stale error). */
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const selRef = useRef(sel)
  useEffect(() => {
    selRef.current = sel
  })

  // hand-off from another tab: open that opening (at that node). Applied during render (the
  // request present at mount is already in the initial state), then cleared in an effect.
  const [prevRequest, setPrevRequest] = useState(learnRequest)
  if (learnRequest && learnRequest !== prevRequest) {
    setPrevRequest(learnRequest)
    setSel({
      openingId: learnRequest.openingId,
      initial: { nodeId: learnRequest.nodeId, token: (sel?.initial.token ?? 0) + 1 },
      restored: false,
    })
  }
  useEffect(() => {
    if (learnRequest) clearRequest('learn')
  }, [learnRequest, clearRequest])

  const openingId = sel?.openingId ?? null
  const loadKey = `${openingId}#${reload}`
  useEffect(() => {
    if (!openingId) return
    const ctrl = new AbortController()
    const key = `${openingId}#${reload}`
    api
      .getOpening(openingId, ctrl.signal)
      .then((o) => setOpening(o))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        if (selRef.current?.restored) {
          // the remembered opening is gone (file removed/renamed) or the backend is down: show the gallery
          removeKey(LEARN_LAST_KEY)
          setSel(null)
          return
        }
        const message =
          err instanceof ApiError && err.status === 404
            ? t('Unknown opening "{id}".', { id: openingId })
            : err instanceof Error
              ? err.message
              : String(err)
        setError({ key, message })
      })
    return () => ctrl.abort()
  }, [openingId, reload])

  const backToGallery = () => {
    removeKey(LEARN_LAST_KEY)
    setSel(null)
    setOpening(null)
    setError(null)
  }

  let content: JSX.Element
  if (!sel) {
    content = (
      <LearnGallery
        onOpen={(id) => setSel((cur) => ({ openingId: id, initial: { token: (cur?.initial.token ?? 0) + 1 }, restored: false }))}
      />
    )
  } else if (error && error.key === loadKey) {
    content = (
      <div className="learn-center">
        <EmptyState
          icon="warning"
          title={t('Could not open this opening')}
          description={error.message}
          action={
            <div className="row">
              <button type="button" className="btn" onClick={backToGallery}>
                <Icon name="prev" size={16} /> {t('All openings')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>
                <Icon name="refresh" size={16} /> {t('Retry')}
              </button>
            </div>
          }
        />
      </div>
    )
  } else if (!opening || opening.id !== sel.openingId) {
    content = (
      <div className="learn-center learn-loading">
        <Spinner size={28} />
        <span className="muted">{t('Loading opening…')}</span>
      </div>
    )
  } else {
    content = <LearnOpeningView key={opening.id} opening={opening} initial={sel.initial} onBack={backToGallery} />
  }

  return <div className="learn-tab">{content}</div>
}
