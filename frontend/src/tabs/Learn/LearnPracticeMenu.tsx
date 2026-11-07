/**
 * Practice options (gear button under the board): auto-reply on/off, how the opponent picks its
 * reply, and whether the coach explains every practice move. Persisted by useLearnPractice.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'
import type { LearnPracticeSettings, LearnReplyMode } from './useLearnPractice'

export interface LearnPracticeMenuProps {
  settings: LearnPracticeSettings
  onChange: (patch: Partial<LearnPracticeSettings>) => void
  /** Model the coach uses (for the hint), "" = backend default. */
  model: string
}

const REPLY_OPTIONS: { value: LearnReplyMode; label: string }[] = [
  { value: 'line', label: 'Follow line' },
  { value: 'random', label: 'Random variation' },
]

export function LearnPracticeMenu({ settings, onChange, model }: LearnPracticeMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const off = !settings.autoReply
  return (
    <div className="learn-practice-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-ghost btn-icon btn-sm learn-practice-gear${open ? ' on' : ''}${off ? ' warn' : ''}`}
        title={`Practice options (auto-reply ${settings.autoReply ? 'on' : 'off'})`}
        aria-label="Practice options"
        aria-expanded={open}
        data-testid="learn-practice-options"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="settings" size={16} />
      </button>
      {open ? (
        <div className="learn-practice-pop" role="menu" data-testid="learn-practice-pop">
          <div className="learn-practice-pop-title">Practice</div>
          <Toggle
            className="learn-opt-autoreply"
            checked={settings.autoReply}
            onChange={(v) => onChange({ autoReply: v })}
            label="Auto-reply"
            title="The opponent answers your board moves automatically"
          />
          <Select<LearnReplyMode>
            className="learn-opt-replymode"
            label="Opponent replies"
            value={settings.replyMode}
            options={REPLY_OPTIONS}
            onChange={(v) => onChange({ replyMode: v })}
            disabled={!settings.autoReply}
            title="Follow line = the line you are on; Random variation = any reply in the tree (popular ones more often)"
          />
          <Toggle
            className="learn-opt-explain"
            checked={settings.autoExplain}
            onChange={(v) => onChange({ autoExplain: v })}
            label="Coach explains every move"
            title="Ask the Ollama coach to explain each move you and the opponent play"
          />
          <p className="learn-practice-pop-hint dim">
            Coach model: {model || 'backend default'} (change it in Settings). Engine verdicts are always shown. The
            explanations come from a local AI model and can get details wrong; badges and evaluations come from Stockfish.
            While you practise, the move arrows stay hidden on your turn (the arrows button shows a hint).
          </p>
        </div>
      ) : null}
    </div>
  )
}
