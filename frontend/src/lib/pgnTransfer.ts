/** Getting games out of the app: the clipboard, .pgn downloads and PGN dates. */

/** Copy text to the clipboard; falls back to execCommand when the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** A date as a PGN Date tag ("2026.11.06"). */
export function pgnDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}

/** A safe file name: "You vs Maia (1100)" becomes "You_vs_Maia_1100.pgn". */
export function pgnFileName(title: string): string {
  return `${title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'game'}.pgn`
}

export function downloadPgn(pgn: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000) // revoking at once can cancel the download
}
