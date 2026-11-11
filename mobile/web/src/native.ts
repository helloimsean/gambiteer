/** The Android side of the app (MainActivity.Bridge). Undefined in a desktop browser. */
import { t } from '@frontend/lib/i18n'

export type CoachState = 'absent' | 'waiting' | 'downloading' | 'verifying' | 'ready' | 'failed'

export interface CoachModelStatus {
  id: string
  name: string
  label: string
  description: string
  bytes: number
  downloaded: number
  state: CoachState
  error?: string
  note?: string
}

export interface CoachStatus {
  models: CoachModelStatus[]
  backend: string | null
}

interface NativeBridge {
  coachStatus(): string
  downloadCoach(id: string, allowMobileData: boolean): void
  cancelCoach(id: string): void
  deleteCoach(id: string): void
  setKeepScreenOn(on: boolean): void
  saveTextFile(name: string, text: string): boolean
  /** The app's language code (see @frontend/lib/i18n), for Android's own texts. */
  setLanguage(code: string): void
}

declare global {
  interface Window {
    GambiteerNative?: NativeBridge
    __gambiteerBack?: () => boolean
  }
}

export const native: NativeBridge | undefined = window.GambiteerNative

export function readCoachStatus(): CoachStatus | null {
  if (!native) return null
  try {
    return JSON.parse(native.coachStatus()) as CoachStatus
  } catch (error) {
    console.error('coach status', error)
    return null
  }
}

function toast(message: string): void {
  const element = document.createElement('div')
  element.className = 'm-toast'
  element.textContent = message
  document.body.appendChild(element)
  setTimeout(() => element.remove(), 2600)
}

/** A WebView cannot follow `<a download href="blob:...">`, so PGN downloads go through Android. */
export function installNativeHooks(): void {
  // A long press fires contextmenu. The promotion chooser treats that as "right-click = queen", so
  // holding a finger on the knight would promote to a queen. Nothing on a phone needs this event.
  window.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    { capture: true },
  )
  const bridge = native
  if (!bridge) return
  const blobs = new Map<string, Blob>()
  const createObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = createObjectURL(object)
    if (object instanceof Blob) blobs.set(url, object)
    return url
  }
  const click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
    const blob = blobs.get(this.href)
    if (!blob || !this.download) {
      click.call(this)
      return
    }
    const name = this.download
    blobs.delete(this.href)
    void blob.text().then((text) => {
      toast(bridge.saveTextFile(name, text) ? t('Saved {name} to Downloads', { name }) : t('Could not save the file'))
    })
  }
}
