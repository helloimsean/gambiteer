import { useRef, type ChangeEvent, type JSX } from 'react'
import { t } from '../lib/i18n'
import { Icon } from './Icon'

/** One game is a few kB; anything far larger is a whole database, and only its first game is read. */
const MAX_FILE_BYTES = 2_000_000

export interface PgnFileButtonProps {
  onText: (text: string) => void
  onError: (message: string) => void
  disabled?: boolean
}

/** Opens a file picker for a .pgn file and hands over its text. */
export function PgnFileButton({ onText, onError, disabled }: PgnFileButtonProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // so choosing the same file again still fires a change
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      onError(t('{name} is over 2 MB. Open a file with just the game you want.', { name: file.name }))
      return
    }
    try {
      onText(await file.text())
    } catch {
      onError(t('Could not read {name}.', { name: file.name }))
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pgn,text/plain,application/x-chess-pgn"
        hidden
        onChange={(e) => void onChange(e)}
        data-testid="pgn-file-input"
      />
      <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()} disabled={disabled} data-testid="pgn-file-open">
        <Icon name="upload" size={14} /> {t('Open .pgn file')}
      </button>
    </>
  )
}
