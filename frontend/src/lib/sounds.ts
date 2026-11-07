/**
 * Tiny WebAudio synthesiser for board sounds. No audio files, no dependencies.
 *
 *   playSound('move')     short wooden click
 *   playSound('capture')  lower, longer thud
 *   playSound('check')    two-tone ping
 *   playSound('illegal')  buzzy low error tone
 *   playSound('promote')  rising chime
 *   playSound('gameEnd')  three-note cadence
 *
 * Audio is muted via `setMuted(true)` (the shell wires this to the sound setting).
 * The AudioContext is created lazily on first play, which satisfies autoplay policies
 * as long as the first sound follows a user gesture (a move always does).
 */

export type SoundName = 'move' | 'capture' | 'check' | 'illegal' | 'promote' | 'gameEnd'

let ctx: AudioContext | null = null
let muted = false

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
  switch (name) {
    case 'move':
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
  }
}

/** Pick move/capture/check for a transition between two FENs and play it. */
export function playMoveSound(fenBefore: string, fenAfter: string, inCheck: boolean): void {
  if (inCheck) return playSound('check')
  const count = (fen: string) => (fen.split(' ')[0] ?? '').replace(/[^a-zA-Z]/g, '').length
  playSound(count(fenAfter) < count(fenBefore) ? 'capture' : 'move')
}
