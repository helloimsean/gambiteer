/** Ollama model chooser + the friendly "Ollama is not running" note. */
import type { JSX } from 'react'
import { Icon } from '../../components/Icon'
import { Select, type SelectOption } from '../../components/Select'
import { Spinner } from '../../components/Spinner'
import type { ReviewModelsState } from './useReviewModels'

export interface ReviewModelPickerProps {
  models: ReviewModelsState & { retry: () => void }
  /** Stored setting ("" = backend default). */
  value: string
  onChange: (model: string) => void
  label?: string
  compact?: boolean
  disabled?: boolean
}

function prettySize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function ReviewModelPicker({ models, value, onChange, label, compact, disabled }: ReviewModelPickerProps): JSX.Element {
  if (models.status === 'loading') {
    return (
      <div className="review-model-loading muted small">
        <Spinner size={14} /> Checking Ollama…
      </div>
    )
  }
  if (models.status === 'down') {
    return <ReviewOllamaDown onRetry={models.retry} compact={compact} detail={models.error} />
  }
  const effective = value || models.defaultModel
  const names = models.models.map((m) => m.name)
  const options: SelectOption<string>[] = models.models.map((m) => ({
    value: m.name,
    label: compact
      ? `${m.name}${m.name === models.defaultModel ? ' (default)' : ''}`
      : `${m.name}${m.parameter_size ? ` · ${m.parameter_size}` : ''}${m.size ? ` · ${prettySize(m.size)}` : ''}${m.name === models.defaultModel ? ' (default)' : ''}`,
  }))
  if (effective && !names.includes(effective)) options.push({ value: effective, label: `${effective} (not installed)` })
  return (
    <Select
      className={`review-model-select${compact ? ' compact' : ''}`}
      label={label}
      value={effective}
      options={options}
      onChange={onChange}
      disabled={disabled}
      title="Ollama model used for explanations"
    />
  )
}

export interface ReviewOllamaDownProps {
  onRetry: () => void
  compact?: boolean
  detail?: string
}

export function ReviewOllamaDown({ onRetry, compact, detail }: ReviewOllamaDownProps): JSX.Element {
  return (
    <div className={`review-ollama-down${compact ? ' compact' : ''}`} role="status" data-testid="review-ollama-down">
      <Icon name="info" size={18} />
      <div className="grow">
        <div className="bold">Explanations need Ollama</div>
        {compact ? (
          <div className="small muted">
            Ollama is not running (or has no models), so the coach is offline. Start Ollama, then retry.
          </div>
        ) : (
          <div className="small muted">
            Ollama is not running on this PC (or has no models), so the coach cannot explain moves. The review itself
            still works. Start Ollama and pull a small model, e.g. <code>ollama pull llama3.2:3b</code>, then retry.
          </div>
        )}
        {detail && !compact ? <div className="small dim review-ollama-detail">{detail}</div> : null}
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        <Icon name="refresh" size={14} /> Retry
      </button>
    </div>
  )
}
