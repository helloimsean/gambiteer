import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '../../components/Icon'
import { START_FEN } from '../../lib/chess'
import { looksLikeFen, normalizeFen, parseGame, type ParsedGame } from './analyzeHelpers'

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

function NoticeLine({ notice }: { notice: Notice | null }): JSX.Element | null {
  if (!notice) return null
  return (
    <div className={`analyze-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="analyze-notice">
      <Icon name={notice.kind === 'error' ? 'warning' : 'check'} size={14} />
      <span>{notice.text}</span>
    </div>
  )
}

export interface AnalyzeImportProps {
  /** Load a position (already validated + normalised). */
  onLoadFen: (fen: string) => void
  /** Load a parsed game. */
  onLoadGame: (game: ParsedGame) => void
}

/** "Import" tab: paste a FEN or a PGN, then Load. */
export function AnalyzeImport({ onLoadFen, onLoadGame }: AnalyzeImportProps): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  useEffect(() => () => ctrlRef.current?.abort(), [])

  const load = async () => {
    const input = text.trim()
    if (!input) {
      setNotice({ kind: 'error', text: 'Paste a FEN or a PGN first.' })
      return
    }
    if (looksLikeFen(input)) {
      const res = normalizeFen(input)
      if ('error' in res) {
        setNotice({ kind: 'error', text: `Invalid FEN: ${res.error}` })
        return
      }
      onLoadFen(res.fen)
      setNotice({ kind: 'ok', text: 'Position loaded from FEN.' })
      return
    }
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setBusy(true)
    setNotice(null)
    try {
      const game = await parseGame(input, ctrl.signal)
      if (ctrl.signal.aborted) return
      if (game.sans.length === 0 && game.startFen === START_FEN) {
        setNotice({ kind: 'error', text: 'No moves found in that PGN.' })
        return
      }
      onLoadGame(game)
      const who = game.headers.White && game.headers.Black && game.headers.White !== '?' ? ` (${game.headers.White} vs ${game.headers.Black})` : ''
      setNotice({ kind: 'ok', text: `PGN loaded: ${game.sans.length} half-moves${who}.` })
    } catch (err) {
      if (ctrl.signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      setNotice({ kind: 'error', text: `Could not read that PGN: ${msg.replace(/^bad PGN:\s*/, '')}` })
    } finally {
      if (!ctrl.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className="analyze-form" data-testid="analyze-import">
      <label className="field">
        <span className="field-label">FEN or PGN</span>
        <textarea
          className="analyze-import-text"
          value={text}
          spellCheck={false}
          placeholder={'Paste a FEN (rnbqkbnr/pppppppp/8/...) or a PGN ([Event "..."] 1. e4 e5 2. Nf3 ...)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void load()
            }
          }}
        />
      </label>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => void load()} disabled={busy} data-testid="analyze-import-load">
          <Icon name="upload" size={16} /> {busy ? 'Loading…' : 'Load'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => { setText(''); setNotice(null) }} disabled={busy || !text}>
          Clear
        </button>
        <span className="spacer" />
        <span className="dim small">Ctrl+Enter</span>
      </div>
      <NoticeLine notice={notice} />
      <p className="dim small analyze-form-hint">
        A PGN replaces the move list and jumps to its last move. Comments and variations are ignored (main line only).
      </p>
    </div>
  )
}

export interface AnalyzeSetupProps {
  /** Current board position. */
  fen: string
  onLoadFen: (fen: string) => void
  onCopyFen: () => void
}

/** "Set up position" tab: edit the FEN of the current position and apply it as a new start. */
export function AnalyzeSetup({ fen, onLoadFen, onCopyFen }: AnalyzeSetupProps): JSX.Element {
  // null = follow the board; a string = the user is editing
  const [draft, setDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const value = draft ?? fen

  const apply = () => {
    const res = normalizeFen(value)
    if ('error' in res) {
      setNotice({ kind: 'error', text: `Invalid FEN: ${res.error}` })
      return
    }
    onLoadFen(res.fen)
    setDraft(null)
    setNotice({ kind: 'ok', text: 'Position set. The move list starts here.' })
  }

  const turn = value.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w'
  const setTurn = (t: 'w' | 'b') => {
    const parts = value.trim().split(/\s+/)
    if (parts.length < 2) return
    parts[1] = t
    parts[3] = '-' // an en-passant square is only valid for the side that just moved
    setDraft(parts.join(' '))
  }

  return (
    <div className="analyze-form" data-testid="analyze-setup">
      <label className="field">
        <span className="field-label">Position (FEN)</span>
        <textarea
          className="analyze-setup-fen"
          value={value}
          spellCheck={false}
          rows={3}
          onChange={(e) => {
            setDraft(e.target.value)
            setNotice(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
          data-testid="analyze-setup-fen"
        />
      </label>
      <div className="row wrap">
        <div className="btn-group" role="group" aria-label="Side to move">
          <button type="button" className={`btn btn-sm${turn === 'w' ? ' active' : ''}`} onClick={() => setTurn('w')}>
            White to move
          </button>
          <button type="button" className={`btn btn-sm${turn === 'b' ? ' active' : ''}`} onClick={() => setTurn('b')}>
            Black to move
          </button>
        </div>
      </div>
      <div className="row wrap">
        <button type="button" className="btn btn-primary" onClick={apply} disabled={draft === null} data-testid="analyze-setup-apply">
          <Icon name="check" size={16} /> Apply
        </button>
        <button type="button" className="btn" onClick={() => { setDraft(null); setNotice(null) }} disabled={draft === null}>
          Revert
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onLoadFen(START_FEN)
            setDraft(null)
            setNotice({ kind: 'ok', text: 'Back to the initial position.' })
          }}
        >
          <Icon name="refresh" size={16} /> Initial position
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCopyFen} title="Copy the current FEN">
          <Icon name="copy" size={16} /> Copy
        </button>
      </div>
      <NoticeLine notice={notice} />
      <p className="dim small analyze-form-hint">
        Edit the FEN (pieces, side to move, castling rights, en passant) and press Apply or Enter. The move list is cleared and starts
        from this position.
      </p>
    </div>
  )
}
