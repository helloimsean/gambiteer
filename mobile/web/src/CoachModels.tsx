import { useEffect, useRef, useState, type JSX } from 'react'
import { Toggle } from '@frontend/components/Toggle'
import { native, readCoachStatus, type CoachModelStatus, type CoachStatus } from './native'

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`
}

/** Current coach model states, refreshed every second while mounted. */
export function useCoachStatus(onReady?: () => void): CoachStatus | null {
  const [status, setStatus] = useState<CoachStatus | null>(readCoachStatus)
  const readyCount = useRef(status?.models.filter((m) => m.state === 'ready').length ?? 0)
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  })

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = readCoachStatus()
      setStatus(next)
      const ready = next?.models.filter((m) => m.state === 'ready').length ?? 0
      if (ready !== readyCount.current) {
        readyCount.current = ready
        onReadyRef.current?.()
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  return status
}

function ModelRow({ model, mobileData }: { model: CoachModelStatus; mobileData: boolean }): JSX.Element {
  const busy = model.state === 'downloading' || model.state === 'waiting'
  const percent = model.bytes > 0 ? Math.min(100, (model.downloaded / model.bytes) * 100) : 0
  let detail: string
  switch (model.state) {
    case 'ready':
      detail = `Ready · ${gigabytes(model.bytes)}`
      break
    case 'downloading':
      detail = `${gigabytes(model.downloaded)} of ${gigabytes(model.bytes)}`
      break
    case 'waiting':
      detail = model.note ?? 'Waiting to start'
      break
    case 'verifying':
      detail = 'Checking the download…'
      break
    case 'failed':
      detail = model.error ?? 'The download failed.'
      break
    default:
      detail = `${model.description} · ${gigabytes(model.bytes)}`
  }
  return (
    <div className="m-model" data-testid={`coach-model-${model.id}`}>
      <div className="m-model-head">
        <div className="settings-text">
          <span>{model.label}</span>
          <small className={model.state === 'failed' ? 'm-error' : undefined}>{detail}</small>
        </div>
        {model.state === 'ready' ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => native?.deleteCoach(model.id)}>
            Delete
          </button>
        ) : busy ? (
          <button type="button" className="btn btn-sm" onClick={() => native?.cancelCoach(model.id)}>
            Cancel
          </button>
        ) : model.state === 'verifying' ? null : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => native?.downloadCoach(model.id, mobileData)}>
            Download
          </button>
        )}
      </div>
      {busy ? (
        <div className="progress">
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  )
}

/** Settings section: download or delete the on-device coach models. */
export function CoachModels({ onChange }: { onChange: () => void }): JSX.Element {
  const status = useCoachStatus(onChange)
  const [mobileData, setMobileData] = useState(false)

  if (!native || !status) {
    return <small className="muted">Coach models can only be managed in the Android app.</small>
  }
  return (
    <div className="col gap-12">
      {status.models.map((model) => (
        <ModelRow key={model.id} model={model} mobileData={mobileData} />
      ))}
      <div className="settings-row">
        <div className="settings-text">
          <span>Use mobile data</span>
          <small>Off: downloads wait for Wi-Fi</small>
        </div>
        <Toggle checked={mobileData} onChange={setMobileData} />
      </div>
      {status.backend ? <small className="muted">The coach is running on the {status.backend}.</small> : null}
    </div>
  )
}
