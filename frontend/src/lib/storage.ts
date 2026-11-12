/**
 * Typed localStorage helpers. Every call is wrapped in try/catch because storage can be
 * unavailable (private mode, blocked, quota) and the app must keep working without it.
 *
 * Known keys:
 *   settings-v1     AppSettings (shell)
 *   quiz-stats-v1   { [openingId]: { [nodeId]: { correct, wrong, lastSeen } } } (Quiz tab)
 *   last-game-v1    LastGame (shell, so Review survives a reload)
 *   game-history-v1 HistoryGame[] (lib/gameHistory.ts)
 *   nav-more-open-v1 boolean (sidebar More / Less)
 *   review-advanced-open-v1 boolean (Review: the advanced Stockfish settings folded open)
 */

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveJson<T>(key: string, value: T): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Like `loadJson`, from sessionStorage (this tab only, survives reloads). */
export function loadSessionJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Like `saveJson`, to sessionStorage. `undefined` removes the key. */
export function saveSessionJson<T>(key: string, value: T | undefined): void {
  try {
    if (value === undefined) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Load, mutate, save. The updater receives the stored value (or `fallback`) and returns the new one. */
export function updateJson<T>(key: string, fallback: T, updater: (current: T) => T): T {
  const next = updater(loadJson(key, fallback))
  saveJson(key, next)
  return next
}
