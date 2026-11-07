/**
 * Coach verdicts and explanations for the Learn tab over one /ws/coach socket per opening view.
 *
 * - Engine verdicts are cached per (opening, node), for every model; explanations per (opening,
 *   model, node, line variant), because the opponent-move and off-book prompts depend on the
 *   followed line (see learnCoach.ts). Both live in memory and, once finished, in localStorage
 *   (capped), so going back and forth never re-queries a move.
 * - The socket is opened lazily on the first request and closed on unmount. If it drops, pending
 *   moves show an error and the next request opens a new socket.
 * - Replies are matched to their move by `requestId`, so a late reply only ever fills the entry
 *   of the move it belongs to, never the card of the move on screen.
 * - The server streams explanations one at a time in request order and has no cancel message.
 *   Explanations of the moves on screen and of the pair the student just left are kept (so the
 *   opponent's reply still gets explained after the student moves on). When a new explanation is
 *   needed, or one on screen waits behind, while explanations of older moves are still queued or
 *   streaming, the socket is replaced: those are dropped (their verdicts, if still missing, are
 *   re-requested without an explanation) and the kept ones re-sent, the moves on screen first.
 *   Nothing is restarted when the moves on screen are already ahead in the queue.
 * - Work that was asked for but not delivered (dropped that way, or lost when the view unmounted
 *   or the page reloaded) is remembered in sessionStorage and re-requested as soon as its move is
 *   on screen again.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openCoachSocket, type CoachSocket } from '../../api/client'
import type { CoachMove, CoachRequest } from '../../api/types'
import { loadSessionJson, saveSessionJson } from '../../lib/storage'
import {
  LEARN_COACH_DEPTH,
  learnCoachErrorText,
  learnLoadCoachCache,
  learnMoveKey,
  learnSaveCoachText,
  learnSaveCoachVerdict,
  learnTextKey,
  learnVerdictKey,
  type LearnCoachItem,
} from './learnCoach'

export type LearnVerdictState = 'idle' | 'pending' | 'done' | 'error'
export type LearnTextState = 'idle' | 'queued' | 'streaming' | 'done' | 'error'

interface VerdictEntry {
  verdict: CoachMove | null
  verdictState: LearnVerdictState
  /** Friendly message when the verdict failed. */
  verdictError?: string
}

interface TextEntry {
  text: string
  textState: LearnTextState
  /** Friendly message when the explanation failed. */
  textError?: string
}

export type LearnCoachEntry = VerdictEntry & TextEntry

export interface LearnEnsureOptions {
  /** Also get an explanation (otherwise only the engine verdict). */
  explain: boolean
  /** Retry moves that failed before (explicit "Ask the coach"); automatic requests do not. */
  retry?: boolean
}

export interface LearnCoachApi {
  /** Verdict + explanation of a move for the current model and its line variant. */
  entry: (item: LearnCoachItem) => LearnCoachEntry | undefined
  /**
   * Make sure every item has a verdict (and an explanation when `opts.explain`). Idempotent:
   * cached or in-flight moves are not re-sent. `onScreen` = the moves shown right now (asked-for
   * work on them that was dropped or lost is resumed; queued explanations of older moves are
   * dropped when they would delay these).
   */
  ensure: (items: readonly LearnCoachItem[], opts: LearnEnsureOptions, onScreen: readonly LearnCoachItem[]) => void
}

interface Pending {
  seq: number
  /** verdict key */
  vkey: string
  /** explanation key (model + line variant) */
  tkey: string
  /** move key (no model): what was asked for */
  mkey: string
  item: LearnCoachItem
  explain: boolean
}

interface Store {
  v: Record<string, VerdictEntry>
  t: Record<string, TextEntry>
}

const EMPTY_V: VerdictEntry = { verdict: null, verdictState: 'idle' }
const EMPTY_T: TextEntry = { text: '', textState: 'idle' }
const LOST = 'Lost the connection to the coach'

/** sessionStorage: asked-for work not delivered yet, { [openingId]: { [moveKey]: explain } }. */
const WANTED_KEY = 'learn-coach-wanted-v1'
type WantedStore = Record<string, Record<string, boolean>>

function loadWanted(openingId: string): Map<string, boolean> {
  const all = loadSessionJson<WantedStore | null>(WANTED_KEY, null)
  const mine = all && typeof all === 'object' ? all[openingId] : null
  const out = new Map<string, boolean>()
  if (mine && typeof mine === 'object') for (const [k, v] of Object.entries(mine)) out.set(k, v === true)
  return out
}

function saveWanted(openingId: string, wanted: ReadonlyMap<string, boolean>): void {
  const raw = loadSessionJson<WantedStore | null>(WANTED_KEY, null)
  const all: WantedStore = raw && typeof raw === 'object' ? raw : {}
  if (wanted.size === 0) delete all[openingId]
  else all[openingId] = Object.fromEntries(wanted)
  saveSessionJson(WANTED_KEY, Object.keys(all).length > 0 ? all : undefined)
}

function fromCache(openingId: string): Store {
  const cached = learnLoadCoachCache(openingId)
  const store: Store = { v: {}, t: {} }
  for (const [key, move] of Object.entries(cached.verdicts)) store.v[key] = { verdict: move, verdictState: 'done' }
  for (const [key, text] of Object.entries(cached.texts)) store.t[key] = { text, textState: 'done' }
  return store
}

const isActive = (t: TextEntry | undefined) => t?.textState === 'queued' || t?.textState === 'streaming'

/**
 * @param openingId the opening of the view (the view is remounted for another opening)
 * @param model     Ollama model ("" = backend default)
 */
export function useLearnCoach(openingId: string, model: string): LearnCoachApi {
  const [store, setStore] = useState<Store>(() => fromCache(openingId))
  /** Same as `store`, updated synchronously (several patches can happen before a render). */
  const storeRef = useRef(store)
  const modelRef = useRef(model)
  useLayoutEffect(() => {
    modelRef.current = model
  })
  const pendingRef = useRef(new Map<string, Pending>())
  const [wanted] = useState(() => loadWanted(openingId))
  const sockRef = useRef<CoachSocket | null>(null)
  const seqRef = useRef(0)
  /** Explanation keys of the pair on screen (by its first move) and of the pair before it. */
  const pairRef = useRef<{ first: string; keys: Set<string> }>({ first: '', keys: new Set() })
  const prevPairRef = useRef<ReadonlySet<string>>(new Set())

  const patchV = useCallback((key: string, fn: (cur: VerdictEntry) => VerdictEntry) => {
    const all = storeRef.current
    const cur = all.v[key] ?? EMPTY_V
    const next = fn(cur)
    if (next === cur) return
    const copy = { ...all, v: { ...all.v, [key]: next } }
    storeRef.current = copy
    setStore(copy)
  }, [])

  const patchT = useCallback((key: string, fn: (cur: TextEntry) => TextEntry) => {
    const all = storeRef.current
    const cur = all.t[key] ?? EMPTY_T
    const next = fn(cur)
    if (next === cur) return
    const copy = { ...all, t: { ...all.t, [key]: next } }
    storeRef.current = copy
    setStore(copy)
  }, [])

  /** Remember (explain = true / false) or forget (null) asked-for work on a move. */
  const want = useCallback(
    (mkey: string, explain: boolean | null) => {
      if (explain === null) wanted.delete(mkey)
      else wanted.set(mkey, explain || wanted.get(mkey) === true)
      saveWanted(openingId, wanted)
    },
    [openingId, wanted],
  )

  /** Every pending request failed (socket lost). */
  const failAll = useCallback(
    (message: string) => {
      const list = [...pendingRef.current.values()]
      pendingRef.current.clear()
      const msg = learnCoachErrorText(message, 'analysis')
      for (const p of list) {
        patchV(p.vkey, (e) => (e.verdictState === 'pending' ? { ...e, verdictState: 'error', verdictError: msg } : e))
        if (p.explain) patchT(p.tkey, (e) => (isActive(e) ? { ...e, textState: 'error', textError: msg } : e))
        wanted.delete(p.mkey) // shown as an error with Retry; not resumed automatically
      }
      saveWanted(openingId, wanted)
    },
    [openingId, patchV, patchT, wanted],
  )

  const getSocket = useCallback((): CoachSocket => {
    const cur = sockRef.current
    if (cur && !cur.closed) return cur
    const sock: CoachSocket = openCoachSocket({
      onAnalysis: (id, move) => {
        const p = pendingRef.current.get(id)
        if (!p) return
        patchV(p.vkey, () => ({ verdict: move, verdictState: 'done' }))
        learnSaveCoachVerdict(p.vkey, move)
      },
      onToken: (id, text) => {
        const p = pendingRef.current.get(id)
        if (!p || !p.explain) return
        patchT(p.tkey, (e) => ({ text: (e.textState === 'streaming' ? e.text : '') + text, textState: 'streaming' }))
      },
      onDone: (id, text) => {
        const p = pendingRef.current.get(id)
        if (!p) return
        pendingRef.current.delete(id)
        if (!p.explain) {
          if (wanted.get(p.mkey) === false) want(p.mkey, null)
          return
        }
        const full = (text || storeRef.current.t[p.tkey]?.text || '').trim()
        if (full) {
          patchT(p.tkey, () => ({ text: full, textState: 'done' }))
          learnSaveCoachText(p.tkey, full)
        } else {
          patchT(p.tkey, () => ({ text: '', textState: 'error', textError: learnCoachErrorText('empty answer', 'explain') }))
        }
        want(p.mkey, null)
      },
      onError: (id, stage, message) => {
        const p = pendingRef.current.get(id)
        if (!p) return
        pendingRef.current.delete(id)
        if (stage === 'analysis') {
          const msg = learnCoachErrorText(message, 'analysis')
          patchV(p.vkey, (e) => (e.verdictState !== 'done' ? { ...e, verdictState: 'error', verdictError: msg } : e))
          if (p.explain) patchT(p.tkey, (e) => (e.textState !== 'done' ? { ...e, textState: 'error', textError: msg } : e))
        } else {
          patchT(p.tkey, (e) =>
            e.textState === 'done' ? e : { text: '', textState: 'error', textError: learnCoachErrorText(message, 'explain') },
          )
        }
        want(p.mkey, null)
      },
      onClose: () => {
        if (sockRef.current === sock) sockRef.current = null
        failAll(LOST)
      },
    })
    sockRef.current = sock
    return sock
  }, [patchV, patchT, failAll, want, wanted])

  const send = useCallback(
    (item: LearnCoachItem, explain: boolean) => {
      const seq = ++seqRef.current
      const requestId = `c${seq}`
      const m = modelRef.current
      const req: CoachRequest = { requestId, fen: item.fen, uci: item.uci, explain, depth: LEARN_COACH_DEPTH, context: item.context }
      if (m) req.model = m
      const mkey = learnMoveKey(item)
      pendingRef.current.set(requestId, {
        seq,
        vkey: learnVerdictKey(openingId, item.nodeId),
        tkey: learnTextKey(openingId, m, item),
        mkey,
        item,
        explain,
      })
      want(mkey, explain)
      getSocket().send(req)
    },
    [openingId, getSocket, want],
  )

  const ensure = useCallback(
    (items: readonly LearnCoachItem[], opts: LearnEnsureOptions, onScreen: readonly LearnCoachItem[]) => {
      const keyT = (it: LearnCoachItem) => learnTextKey(openingId, model, it)
      const keyV = (it: LearnCoachItem) => learnVerdictKey(openingId, it.nodeId)
      const screen = new Set(onScreen.map(keyT))

      // the pair the student just left stays protected (its explanations finish)
      const first = onScreen[0] ? learnMoveKey(onScreen[0]) : ''
      if (first !== pairRef.current.first) {
        prevPairRef.current = pairRef.current.keys
        pairRef.current = { first, keys: new Set(screen) }
      } else {
        for (const k of screen) pairRef.current.keys.add(k)
      }
      const keep = new Set([...screen, ...prevPairRef.current])

      // ---- what to request now
      const pendingList = [...pendingRef.current.values()]
      const plannedV = new Set(pendingList.map((p) => p.vkey))
      const plannedT = new Set(pendingList.filter((p) => p.explain).map((p) => p.tkey))
      const plan: { item: LearnCoachItem; explain: boolean }[] = []
      const consider = (item: LearnCoachItem, explain: boolean, retry: boolean): boolean => {
        const vkey = keyV(item)
        const tkey = keyT(item)
        const v = storeRef.current.v[vkey] ?? EMPTY_V
        const t = storeRef.current.t[tkey] ?? EMPTY_T
        const verdictFailed = v.verdictState === 'error'
        const needVerdict = v.verdictState !== 'done' && !plannedV.has(vkey) && (!verdictFailed || retry)
        const needText =
          explain && t.textState !== 'done' && !plannedT.has(tkey) && (t.textState !== 'error' || retry) && (!verdictFailed || retry)
        if (!needVerdict && !needText) return false
        plannedV.add(vkey)
        if (needText) plannedT.add(tkey)
        plan.push({ item, explain: needText })
        return true
      }
      for (const item of items) consider(item, opts.explain, !!opts.retry)
      // asked-for work on the moves on screen that was dropped or lost (unmount, reload): resume it
      for (const item of onScreen) {
        const mkey = learnMoveKey(item)
        const w = wanted.get(mkey)
        if (w === undefined) continue
        const planned = consider(item, w, false)
        const v = storeRef.current.v[keyV(item)]
        const t = storeRef.current.t[keyT(item)]
        const textOver = t?.textState === 'done' || t?.textState === 'error'
        if (!planned && (v?.verdictState === 'done' || v?.verdictState === 'error') && (!w || textOver)) want(mkey, null)
      }

      const markQueued = (item: LearnCoachItem, explain: boolean) => {
        patchV(keyV(item), (cur) => (cur.verdictState !== 'done' ? { ...cur, verdictState: 'pending', verdictError: undefined } : cur))
        if (explain) patchT(keyT(item), () => ({ text: '', textState: 'queued' }))
      }

      // ---- drop queued explanations of older moves when they would delay the moves on screen
      const stale = pendingList.filter((p) => p.explain && !keep.has(p.tkey) && isActive(storeRef.current.t[p.tkey]))
      const newText = plan.some((x) => x.explain)
      const blocked = stale.some((s) => pendingList.some((p) => p.explain && screen.has(p.tkey) && p.seq > s.seq))
      if (stale.length > 0 && (newText || blocked)) {
        const old = sockRef.current
        sockRef.current = null
        old?.close()
        pendingRef.current.clear()
        const list = [...pendingList].sort((a, b) => a.seq - b.seq)
        const resendScreen = list.filter((p) => p.explain && screen.has(p.tkey))
        const resendKept = list.filter((p) => p.explain && !screen.has(p.tkey) && keep.has(p.tkey))
        const dropped = list.filter((p) => !(p.explain && keep.has(p.tkey)))
        for (const p of dropped) {
          // the explanation is dropped; the move stays "wanted" and is resumed when shown again
          if (p.explain) patchT(p.tkey, (cur) => (isActive(cur) ? { text: '', textState: 'idle' } : cur))
        }
        for (const p of [...resendScreen, ...resendKept]) patchT(p.tkey, (cur) => (cur.textState === 'done' ? cur : { text: '', textState: 'queued' }))
        const resent = new Set<string>()
        for (const p of resendScreen) {
          resent.add(p.vkey)
          send(p.item, true)
        }
        for (const x of plan) {
          markQueued(x.item, x.explain)
          resent.add(keyV(x.item))
          send(x.item, x.explain)
        }
        for (const p of resendKept) {
          resent.add(p.vkey)
          send(p.item, true)
        }
        for (const p of dropped) {
          if (resent.has(p.vkey) || storeRef.current.v[p.vkey]?.verdictState !== 'pending') continue
          resent.add(p.vkey)
          send(p.item, false)
        }
        return
      }

      for (const x of plan) {
        markQueued(x.item, x.explain)
        send(x.item, x.explain)
      }
    },
    [openingId, model, patchV, patchT, send, want, wanted],
  )

  // unmount: close the socket (the server drops its pending work). Unfinished requests are
  // still in `wanted` (sessionStorage), so they resume when their move is shown again.
  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      const s = sockRef.current
      sockRef.current = null
      s?.close()
      pending.clear()
    }
  }, [])

  const entry = useCallback(
    (item: LearnCoachItem): LearnCoachEntry | undefined => {
      const v = store.v[learnVerdictKey(openingId, item.nodeId)]
      const t = store.t[learnTextKey(openingId, model, item)]
      if (!v && !t) return undefined
      return { ...(v ?? EMPTY_V), ...(t ?? EMPTY_T) }
    },
    [store, openingId, model],
  )

  return { entry, ensure }
}
