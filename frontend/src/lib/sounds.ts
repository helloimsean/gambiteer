/**
 * Board sounds. Each one plays public/sounds/<file>.mp3 when that file loaded. Those files are
 * git-ignored because they are not ours to redistribute, so a fresh copy of the repository has none
 * and falls back to the small WebAudio synthesiser below.
 *
 *   playSound('move')          the player's own move
 *   playSound('moveOpponent')  the other side's move
 *   playSound('capture'), playSound('castle'), playSound('check'), playSound('illegal'),
 *   playSound('promote'), playSound('gameStart'), playSound('gameEnd')
 *
 * Audio is muted via `setMuted(true)` (the shell wires this to the sound setting).
 * The AudioContext is created lazily on first play, which satisfies autoplay policies
 * as long as the first sound follows a user gesture (a move always does).
 */
import type { Side } from '../api/types'
import { turnFromFen } from './chess'

export type SoundName = 'move' | 'moveOpponent' | 'capture' | 'castle' | 'check' | 'illegal' | 'promote' | 'gameStart' | 'gameEnd'

const SOUND_FILES: Record<SoundName, string> = {
  move: 'move-self',
  moveOpponent: 'move-opponent',
  capture: 'capture',
  castle: 'castle',
  check: 'move-check',
  illegal: 'illegal',
  promote: 'promote',
  gameStart: 'game-start',
  gameEnd: 'game-end',
}

/** A new game replaces the whole board, which must not also sound like a move. */
const GAME_START_QUIET_MS = 150

/** Only the files that loaded: a missing one never fires `canplaythrough`. */
const samples = new Map<SoundName, HTMLAudioElement>()
let ctx: AudioContext | null = null
let muted = false
let gameStartedAt = -Infinity

function loadSamples(): void {
  if (typeof Audio === 'undefined') return
  for (const [name, file] of Object.entries(SOUND_FILES) as [SoundName, string][]) {
    const audio = new Audio(`/sounds/${file}.mp3`)
    audio.preload = 'auto'
    audio.addEventListener('canplaythrough', () => samples.set(name, audio), { once: true })
  }
}

loadSamples()

function playSample(name: SoundName): boolean {
  const sample = samples.get(name)
  if (!sample) return false
  sample.currentTime = 0
  void sample.play().catch(() => undefined) // browsers refuse audio before the first user gesture
  return true
}

export function setMuted(value: boolean): void {
  muted = value
}

export function isMuted(): boolean {
  return muted
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

interface Tone {
  freq: number
  /** seconds after `start` */
  at: number
  dur: number
  type?: OscillatorType
  gain?: number
  /** frequency to glide to by the end */
  glide?: number
}

function play(tones: Tone[], noise?: { at: number; dur: number; gain: number; lowpass: number }): void {
  if (muted) return
  const ac = getContext()
  if (!ac) return
  const now = ac.currentTime + 0.005
  const master = ac.createGain()
  master.gain.value = 0.9
  master.connect(ac.destination)

  for (const t of tones) {
    const osc = ac.createOscillator()
    const g = ac.createGain()
    osc.type = t.type ?? 'sine'
    osc.frequency.setValueAtTime(t.freq, now + t.at)
    if (t.glide) osc.frequency.exponentialRampToValueAtTime(t.glide, now + t.at + t.dur)
    const peak = t.gain ?? 0.25
    g.gain.setValueAtTime(0.0001, now + t.at)
    g.gain.exponentialRampToValueAtTime(peak, now + t.at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, now + t.at + t.dur)
    osc.connect(g)
    g.connect(master)
    osc.start(now + t.at)
    osc.stop(now + t.at + t.dur + 0.02)
  }

  if (noise) {
    const len = Math.max(1, Math.floor(ac.sampleRate * noise.dur))
    const buf = ac.createBuffer(1, len, ac.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ac.createBufferSource()
    src.buffer = buf
    const filter = ac.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = noise.lowpass
    const g = ac.createGain()
    g.gain.setValueAtTime(noise.gain, now + noise.at)
    g.gain.exponentialRampToValueAtTime(0.0001, now + noise.at + noise.dur)
    src.connect(filter)
    filter.connect(g)
    g.connect(master)
    src.start(now + noise.at)
  }
}

export function playSound(name: SoundName): void {
  if (muted) return
  if (name === 'gameStart') gameStartedAt = performance.now()
  if (playSample(name)) return
  switch (name) {
    case 'move':
    case 'moveOpponent':
    case 'castle':
      play(
        [{ freq: 520, at: 0, dur: 0.06, type: 'triangle', gain: 0.18, glide: 180 }],
        { at: 0, dur: 0.05, gain: 0.35, lowpass: 2600 },
      )
      break
    case 'capture':
      play(
        [
          { freq: 260, at: 0, dur: 0.11, type: 'triangle', gain: 0.3, glide: 90 },
          { freq: 140, at: 0.01, dur: 0.13, type: 'sine', gain: 0.22, glide: 60 },
        ],
        { at: 0, dur: 0.09, gain: 0.5, lowpass: 1400 },
      )
      break
    case 'check':
      play([
        { freq: 880, at: 0, dur: 0.09, type: 'sine', gain: 0.2 },
        { freq: 1320, at: 0.07, dur: 0.14, type: 'sine', gain: 0.18 },
      ])
      break
    case 'illegal':
      play([
        { freq: 160, at: 0, dur: 0.16, type: 'sawtooth', gain: 0.12, glide: 110 },
        { freq: 120, at: 0.02, dur: 0.16, type: 'square', gain: 0.06 },
      ])
      break
    case 'promote':
      play([
        { freq: 660, at: 0, dur: 0.1, type: 'sine', gain: 0.18 },
        { freq: 880, at: 0.08, dur: 0.1, type: 'sine', gain: 0.18 },
        { freq: 1320, at: 0.16, dur: 0.18, type: 'sine', gain: 0.18 },
      ])
      break
    case 'gameEnd':
      play([
        { freq: 523, at: 0, dur: 0.16, type: 'triangle', gain: 0.18 },
        { freq: 659, at: 0.14, dur: 0.16, type: 'triangle', gain: 0.18 },
        { freq: 784, at: 0.28, dur: 0.3, type: 'triangle', gain: 0.2 },
      ])
      break
    case 'gameStart':
      break // no synthesised version
  }
}

/** The 64 squares as one string, leaving out any Crazyhouse pocket, whose pieces are not on the board. */
function boardOf(fen: string): string {
  return (fen.split(' ')[0] ?? '')
    .replace(/\[.*\]|~|\//g, '')
    .replace(/\d/g, (n) => '.'.repeat(Number(n)))
}

function squaresOf(board: string, piece: string): string {
  return [...board].flatMap((p, i) => (p === piece ? [i] : [])).join()
}

/** No other move changes the squares of both the mover's king and the mover's rooks. */
function isCastling(before: string, after: string, mover: Side): boolean {
  const [king, rook] = mover === 'white' ? ['K', 'R'] : ['k', 'r']
  return squaresOf(before, king) !== squaresOf(after, king) && squaresOf(before, rook) !== squaresOf(after, rook)
}

/** Pick the sound for a transition between two FENs and play it. `player` is whose moves are "your" moves. */
export function playMoveSound(fenBefore: string, fenAfter: string, inCheck: boolean, player: Side): void {
  if (performance.now() - gameStartedAt < GAME_START_QUIET_MS) return
  if (inCheck) return playSound('check')
  const before = boardOf(fenBefore)
  const after = boardOf(fenAfter)
  const mover = turnFromFen(fenBefore)
  if (isCastling(before, after, mover)) return playSound('castle')
  const pieces = (board: string) => board.replace(/\./g, '').length
  if (pieces(after) < pieces(before)) return playSound('capture')
  playSound(mover === player ? 'move' : 'moveOpponent')
}
