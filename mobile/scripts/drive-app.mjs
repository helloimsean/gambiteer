// Drives the app's real WebView on a connected phone or emulator, for testing.
//   node scripts/drive-app.mjs coach-download <model id>   tap through Settings and download a model
//   node scripts/drive-app.mjs coach-status                print the download state
//   node scripts/drive-app.mjs ui <output folder>          walk through the main screens with real taps
//   node scripts/drive-app.mjs eval "<javascript>"         run an expression in the page
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ADB = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe')
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
const PORT = 9333
const STATUS_BAR_PX = 63 // the WebView starts below the status bar on the test device

const pid = adb('shell', 'pidof', 'com.gambiteer.mobile')
if (!pid) throw new Error('Gambiteer is not running on the device')
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`)
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const target = targets.find((t) => t.url.includes('127.0.0.1:8000'))
if (!target) throw new Error('the app page is not open yet')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let nextId = 1
const waiting = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
}

function send(method, params) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => waiting.set(id, resolve))
}

async function evaluate(expression) {
  const { result, error } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (error || result.exceptionDetails) throw new Error(JSON.stringify(error ?? result.exceptionDetails))
  return result.result.value
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const status = async () => JSON.parse(await evaluate('window.GambiteerNative.coachStatus()'))
const screenshot = (file) => fs.writeFileSync(file, execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 27 }))

/** A genuine touch at the centre of the first element matching `find` (a JS expression). */
async function tap(find) {
  const box = await evaluate(`(() => { const e = ${find}; if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,d:window.devicePixelRatio}; })()`)
  if (!box) throw new Error(`nothing to tap: ${find}`)
  adb('shell', 'input', 'tap', String(Math.round(box.x * box.d)), String(Math.round(box.y * box.d) + STATUS_BAR_PX))
  await pause(700)
}

const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`
const tabButton = (label) => byText('.m-tab', label)

async function closeIntro() {
  if (await evaluate(`Boolean(${byText('button', 'Later')})`)) await tap(byText('button', 'Later'))
}

const commands = {
  async 'coach-status'() {
    console.log(JSON.stringify(await status()))
  },

  async eval(expression) {
    console.log(JSON.stringify(await evaluate(expression)))
  },

  async 'coach-download'(id) {
    await closeIntro()
    await tap(`document.querySelector('[aria-label="Settings"]')`)
    await tap(`[...document.querySelectorAll('.settings-row')].find((e) => e.textContent.includes('Use mobile data')).querySelector('.ui-toggle')`)
    await tap(`document.querySelector('[data-testid="coach-model-${id}"] .btn-primary')`)
    await pause(2000)
    console.log(JSON.stringify((await status()).models.find((m) => m.id === id)))
  },

  async ui(folder) {
    fs.mkdirSync(folder, { recursive: true })
    const shot = async (name) => {
      await pause(800)
      screenshot(path.join(folder, `${name}.png`))
      console.log('shot', name)
    }
    await closeIntro()
    await tap(tabButton('Analyze'))
    await pause(5000)
    await shot('analyze-live')
    console.log('engine panel:', await evaluate(`document.querySelector('.analyze-side')?.innerText.slice(0, 160)`))
    await tap(tabButton('Learn'))
    await shot('learn')
    await tap(tabButton('Quiz'))
    await shot('quiz')
    await tap(tabButton('Play'))
    await shot('play-setup')
  },
}

const [command, ...args] = process.argv.slice(2)
await commands[command](...args)
socket.close()
process.exit(0)
