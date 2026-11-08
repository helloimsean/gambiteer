// Playwright check of the Maia bot in the Play tab. It never uses a real lc0: the backend must run on
// the stand-in engine (backend/tests/fixtures/fake_lc0.py), so nothing here proves how real Maia plays.
//
//   cd frontend && npm run build
//   cd backend  && LC0_PATH="<project>/backend/tests/fixtures/fake_lc0.py" python -m uvicorn app.main:app --port 8052
//   cd frontend && node src/tabs/Play/PlayMaia.check.mjs [baseUrl]   (default http://localhost:8052)
//
// Needs Stockfish (the student's moves come from /api/analyze, and old games must still reach it).
// Screenshots go to frontend/screenshots/play-maia-*.png. Exit code 0 = all checks passed.
import { Chess } from 'chess.js'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8052'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
mkdirSync(SHOTS, { recursive: true })

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const MISSING_DETAIL = String.raw`Maia is unavailable: lc0 not found at C:\Program Files\Gambiteer\engines\lc0\lc0.exe. Install it with: python tools\install_maia.py, then restart the app.`

const results = []
let failed = 0
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (err) {
    record(name, false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function same(a, b, label) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${label}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}

const TAB = '[data-testid="play-tab"]'
const BOARD = `${TAB} .board-root`
const FORM = `${TAB} [data-testid="play-setup"]`
const DIALOG = '.play-new-modal'
const STATUS = '[data-testid="play-status"]'
const BOT_BAR = '[data-testid="play-bar-bot"]'

// ---------------------------------------------------------------- refuse to run on anything but the stand-in

const healthRes = await fetch(`${BASE}/api/health`)
const health = await healthRes.json()
if (!/fake_lc0\.py$/.test(health.maia?.path ?? '') || !health.maia?.available) {
  console.error(`The backend at ${BASE} is not on the stand-in engine (maia: ${JSON.stringify(health.maia)}).`)
  console.error('Start it with LC0_PATH pointing at backend/tests/fixtures/fake_lc0.py (see the top of this file).')
  process.exit(2)
}

// ---------------------------------------------------------------- browser

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
// the page's own clock, so the reply delay is measured where it happens
await context.addInitScript(() => {
  window.__botTimes = []
  const original = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    const promise = original.call(this, input, init)
    if (url.includes('/api/bot/move')) {
      const row = { sent: performance.now(), answered: null }
      window.__botTimes.push(row)
      promise.then(
        () => {
          row.answered = performance.now()
        },
        () => {},
      )
    }
    return promise
  }
})
const page = await context.newPage()

let expected503 = false
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (expected503 && m.text().includes('503')) return
  consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

/** Every /api/bot/move exchange of the run. */
const botCalls = []
page.on('response', async (res) => {
  if (!res.url().includes('/api/bot/move')) return
  const row = { body: JSON.parse(res.request().postData() ?? '{}'), status: res.status(), reply: null }
  botCalls.push(row)
  try {
    row.reply = await res.json()
  } catch {
    /* page navigated away */
  }
})
const lastCall = () => botCalls[botCalls.length - 1]

async function state() {
  return page.locator(TAB).evaluate((el) => {
    const b = el.querySelector('.board-root')
    return {
      id: el.dataset.gameId,
      bot: el.dataset.bot,
      turn: el.dataset.turn,
      over: el.dataset.over === 'true',
      thinking: el.dataset.thinking === 'true',
      plies: Number(el.dataset.plies),
      fen: b?.getAttribute('data-fen'),
      orientation: b?.getAttribute('data-orientation'),
    }
  })
}
async function waitFor(pred, label, timeout = 20000) {
  const t0 = Date.now()
  let s
  while (Date.now() - t0 < timeout) {
    s = await state()
    if (pred(s)) return s
    await page.waitForTimeout(40)
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
}
/** Resolves with the page's clock at the moment the game reaches `plies`. */
async function pliesReachedAt(plies, timeout = 10000) {
  const handle = await page.waitForFunction(
    ([sel, n]) => (Number(document.querySelector(sel)?.dataset.plies) === n ? performance.now() : false),
    [TAB, plies],
    { timeout },
  )
  return handle.jsonValue()
}
const lastBotTime = () => page.evaluate(() => window.__botTimes[window.__botTimes.length - 1])
/** Wait until the backend has answered the newest bot request (the reply delay is then running). */
async function waitAnswered() {
  await page.waitForFunction(() => {
    const rows = window.__botTimes
    return rows.length > 0 && rows[rows.length - 1].answered !== null
  })
}
async function sleep(ms) {
  await page.waitForTimeout(ms)
}

function center(box, sq, orientation) {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  const s = box.width / 8
  const col = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 7 - rank : rank
  return { x: box.x + s * (col + 0.5), y: box.y + s * (row + 0.5) }
}
async function playUci(uci) {
  const box = await page.locator(`${BOARD} cg-board`).boundingBox()
  assert(box, 'board has no box')
  const { orientation } = await state()
  const a = center(box, uci.slice(0, 2), orientation)
  const b = center(box, uci.slice(2, 4), orientation)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  if (uci.length > 4) {
    const btn = page.locator(`${BOARD} .board-promo button[data-piece="${uci[4]}"]`)
    await btn.waitFor({ timeout: 3000 })
    await btn.click()
    await page.waitForTimeout(100)
  }
}
async function engineMove(fen) {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, multipv: 1, depth: 6 }),
  })
  const data = await res.json()
  return data.lines[0].pvUci[0]
}
async function shot(name) {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/play-maia-${name}.png` })
}
async function gotoPlay() {
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
  await page.waitForTimeout(200)
}
async function resetStorage(entries = {}) {
  await page.evaluate((kv) => {
    localStorage.removeItem('play-game-v1')
    localStorage.removeItem('play-setup-v1')
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, JSON.stringify(v))
  }, entries)
}
async function reload(waitUntil = 'networkidle') {
  await page.reload({ waitUntil })
  await gotoPlay()
}
async function freshStart(entries = {}) {
  await resetStorage(entries)
  await reload()
}
function baseGame(over) {
  return {
    version: 1,
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    studentColor: 'white',
    bot: 'maia',
    elo: 1500,
    movetimeMs: 300,
    startFen: START,
    sans: [],
    basePly: 0,
    marks: {},
    bookStats: { correct: 0, missed: 0 },
    startedAt: Date.now(),
    ...over,
  }
}
async function injectGame(game) {
  await page.evaluate((g) => localStorage.setItem('play-game-v1', JSON.stringify(g)), game)
  await reload()
}
async function clickToolbar(label) {
  await page.locator(`${TAB} .play-toolbar button`, { hasText: label }).click()
}
async function openNewGameDialog() {
  await clickToolbar('New game')
  await page.locator(DIALOG).waitFor()
}
async function startFromDialog() {
  const before = (await state()).id
  await page.locator(`${DIALOG} [data-testid="play-start"]`).click()
  await waitFor((x) => x.id && x.id !== before, 'new game id')
}
async function chooseOpening(scope, openingId, lineId, mode) {
  const toggle = page.locator(`${scope} label.ui-toggle`, { hasText: 'Start from an opening line' })
  if (!(await toggle.locator('input').isChecked())) await toggle.click()
  const selects = page.locator(`${scope} .play-select select`)
  await selects.nth(0).selectOption(openingId)
  await page.waitForFunction(
    ([sc, id]) => {
      const s = document.querySelectorAll(`${sc} .play-select select`)[1]
      return s && !s.disabled && [...s.options].some((o) => o.value === id)
    },
    [scope, lineId],
    { timeout: 10000 },
  )
  await selects.nth(1).selectOption(lineId)
  await page.locator(`${scope} button.play-mode[data-mode="${mode}"]`).click()
}
/** UCI list for a SAN list, as the backend expects it. */
function ucisOf(sans, startFen = START) {
  const c = new Chess(startFen)
  return sans.map((s) => {
    const m = c.move(s)
    return `${m.from}${m.to}${m.promotion ?? ''}`
  })
}

/** Elements sticking out of the page or of their box. */
async function overflowProblems() {
  return page.evaluate(() => {
    const out = []
    const de = document.documentElement
    if (de.scrollWidth > window.innerWidth) out.push(`document ${de.scrollWidth} > ${window.innerWidth}`)
    const tab = document.querySelector('.play-tab')
    if (tab && tab.scrollWidth > tab.clientWidth + 1) out.push(`tab ${tab.scrollWidth} > ${tab.clientWidth}`)
    for (const root of document.querySelectorAll('.play-setup, .play-panel, .ui-modal, .play-toolbar, .play-bar-slot, .board-frame')) {
      const limit = Math.min(root.getBoundingClientRect().right, window.innerWidth)
      for (const el of root.querySelectorAll('*')) {
        const b = el.getBoundingClientRect()
        if (b.width > 0 && b.right > limit + 1) {
          out.push(`${el.tagName}.${String(el.className).slice(0, 40)} right ${Math.round(b.right)} > ${Math.round(limit)}`)
        }
      }
      if (root.getBoundingClientRect().right > window.innerWidth + 1) out.push(`${root.className} leaves the window`)
    }
    return out.slice(0, 6)
  })
}

const selectedBot = () => page.locator(`${FORM} [role="radio"][data-bot][aria-checked="true"]`).getAttribute('data-bot')
const eloShown = (scope = FORM) => page.locator(`${scope} [data-testid="play-elo-value"]`).innerText()
const presetsOf = (scope) => page.locator(`${scope} .play-elo-presets button`).allInnerTexts()

// ---------------------------------------------------------------- run

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await freshStart()

  // ---------------- the form
  await check('the form offers Stockfish and Maia, with the wording and the pill', async () => {
    assert((await page.locator(`${FORM} .play-setup-label`, { hasText: 'Opponent' }).count()) === 1, 'no Opponent label')
    same(await selectedBot(), 'stockfish', 'default bot')
    const sf = await page.locator(`${FORM} [data-bot="stockfish"]`).innerText()
    assert(sf.includes('Stockfish') && sf.includes('The strongest chess engine, held back to the Elo you choose.'), sf)
    const maia = await page.locator(`${FORM} [data-bot="maia"]`).innerText()
    assert(maia.includes('Maia'), maia)
    assert(maia.includes('A neural network trained on millions of real online games. It plays like a person at that rating, including human-style mistakes.'), maia)
    assert(await page.locator(`${FORM} [data-testid="play-maia-pill"]`).isVisible(), 'pill not visible')
    same(await page.locator(`${FORM} [data-testid="play-maia-pill"]`).innerText(), 'More human-like', 'pill text')
    assert((await page.locator(`${FORM} [data-testid="play-maia-install"]`).count()) === 0, 'install note shown although Maia is installed')
    same(await presetsOf(FORM), ['800', '1200', '1500', '2000', '2500', '3190'], 'Stockfish presets')
  })
  await shot('01-form-stockfish')

  await check('choosing Maia: slider 1100-1900 in 100s, presets, caption and notes', async () => {
    await page.locator(`${FORM} [data-bot="maia"]`).click()
    same(await selectedBot(), 'maia', 'selected bot')
    same(await presetsOf(FORM), ['1100', '1300', '1500', '1700', '1900'], 'Maia presets')
    const slider = page.locator(`${FORM} .play-elo-slider input[type=range]`)
    same([await slider.getAttribute('min'), await slider.getAttribute('max'), await slider.getAttribute('step')], ['1100', '1900', '100'], 'slider')
    same(await eloShown(), '1500', 'default rating')
    same(await slider.inputValue(), '1500', 'slider value')
    await slider.focus()
    await page.keyboard.press('End')
    same(await eloShown(), '1900', 'End key')
    await page.keyboard.press('Home')
    same(await eloShown(), '1100', 'Home key')
    await page.keyboard.press('ArrowRight')
    same(await eloShown(), '1200', 'one step')
    await page.locator(`${FORM} button[data-elo="1300"]`).click()
    same(await eloShown(), '1300', 'preset')
    same(await slider.inputValue(), '1300', 'slider follows the preset')
    same(await page.locator(`${FORM} [data-testid="play-strength-caption"]`).innerText(), 'Maia 1300, trained on Lichess players rated about 1300', 'caption')
    same(
      await page.locator(`${FORM} [data-testid="play-strength-note"]`).innerText(),
      'Maia has one trained model per 100 rating points, from 1100 to 1900. These are Lichess ratings and the match is approximate.',
      'rating note',
    )
    same(await page.locator(`${FORM} [data-testid="play-movetime-note"]`).innerText(), "Maia doesn't search, so this is just how long it waits before answering.", 'move time note')
    assert((await page.locator(`${FORM} [data-movetime]`).count()) === 3, 'move time buttons missing')
    same(await page.locator(`${TAB} .panel-title`).innerText(), 'Play vs Maia', 'panel title')
    const bar = await page.locator(BOT_BAR).innerText()
    assert(bar.includes('Maia') && bar.includes('1300') && !bar.includes('Stockfish'), bar)
  })
  await shot('02-form-maia')

  await check('the Stockfish Elo and the Maia Elo are remembered separately, across a reload', async () => {
    await page.locator(`${FORM} [data-bot="stockfish"]`).click()
    await page.locator(`${FORM} button[data-elo="2000"]`).click()
    await page.locator(`${FORM} [data-bot="maia"]`).click()
    await page.locator(`${FORM} button[data-elo="1700"]`).click()
    await page.locator(`${FORM} [data-bot="stockfish"]`).click()
    same(await eloShown(), '2000', 'back on Stockfish')
    same(await page.locator(`${FORM} .play-elo-slider input[type=range]`).inputValue(), '2000', 'Stockfish slider')
    same(await page.locator(`${FORM} .play-elo-slider input[type=range]`).getAttribute('max'), '3190', 'Stockfish slider max')
    await page.locator(`${FORM} [data-bot="maia"]`).click()
    same(await eloShown(), '1700', 'back on Maia')
    same(await page.locator(`${FORM} .play-elo-slider input[type=range]`).inputValue(), '1700', 'Maia slider')
    await reload()
    same(await selectedBot(), 'maia', 'bot after reload')
    same(await eloShown(), '1700', 'Maia after reload')
    await page.locator(`${FORM} [data-bot="stockfish"]`).click()
    same(await eloShown(), '2000', 'Stockfish after reload')
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('play-setup-v1')))
    same([stored.bot, stored.elo, stored.maiaElo], ['stockfish', 2000, 1700], 'stored setup')
  })

  // ---------------- a game
  await check('a full exchange of moves: the bot is called Maia and the request carries the history', async () => {
    await freshStart({ 'play-setup-v1': { color: 'white', bot: 'maia', elo: 1200, maiaElo: 1300, movetimeMs: 300 } })
    await page.locator('[data-testid="play-start"]').click()
    await waitFor((x) => Boolean(x.id), 'game started')
    const first = botCalls.length
    const played = []
    for (let i = 0; i < 6; i++) {
      const s = await waitFor((x) => x.over || (x.turn === 'white' && !x.thinking), 'student turn')
      if (s.over) break
      const uci = await engineMove(s.fen)
      await playUci(uci)
      await waitFor((x) => x.plies >= s.plies + 1, `${uci} applied`, 5000)
      played.push(uci)
      const t = await waitFor((x) => x.over || x.plies >= s.plies + 2, 'bot reply')
      if (t.plies >= s.plies + 2) {
        await waitFor(() => botCalls.length >= first + Math.ceil(played.length / 2) && lastCall().reply !== null, 'reply captured', 3000)
        played.push(lastCall().reply.uci)
      }
    }
    assert(played.length >= 10, `only ${played.length} plies`)
    const calls = botCalls.slice(first)
    assert(calls.length >= 5, `${calls.length} bot calls`)
    for (const [i, c] of calls.entries()) {
      same([c.status, c.body.bot, c.body.elo, c.body.start_fen], [200, 'maia', 1300, START], `call ${i}`)
      same(c.body.moves, played.slice(0, i * 2 + 1), `moves of call ${i}`)
      same(c.reply.strength.mode, 'maia', 'strength mode')
      assert(!('movetime_ms' in c.body), 'movetime_ms sent to Maia')
    }
    const sans = await page.locator(`${TAB} .move-cell .move-san`).allInnerTexts()
    same(sans.length, (await state()).plies, 'move list')
    return `${played.length} plies, moves sent: ${lastCall().body.moves.join(' ')}`
  })
  await shot('03-game')

  await check('in the game the bot is named Maia everywhere, and never Stockfish', async () => {
    const bar = await page.locator(BOT_BAR).innerText()
    assert(bar.includes('Maia') && bar.includes('1300'), bar)
    same(await page.locator(`${TAB} .panel-title`).innerText(), 'vs Maia', 'panel title')
    same(await page.locator(`${TAB} .play-strength`).innerText(), 'Maia 1300, trained on Lichess players rated about 1300', 'strength line')
    same(await page.locator(`${TAB} .panel-header .badge-green`).getAttribute('title'), 'Maia 1300, trained on Lichess players rated about 1300', 'badge title')
    const text = await page.locator(TAB).innerText()
    assert(!text.includes('Stockfish'), 'the tab mentions Stockfish')
  })

  // ---------------- the reply delay
  await check('the reply lands no sooner than the move time after the request started', async () => {
    await injectGame(baseGame({ movetimeMs: 2000 }))
    await playUci('e2e4')
    const landed = pliesReachedAt(2)
    await waitAnswered()
    const midway = await state()
    assert(midway.plies === 1 && midway.thinking, `not waiting: ${JSON.stringify(midway)}`)
    same(await page.locator(STATUS).innerText(), 'Maia is thinking...', 'status while waiting')
    await shot('04-thinking')
    const at = await landed
    const t = await lastBotTime()
    const answered = Math.round(t.answered - t.sent)
    const total = Math.round(at - t.sent)
    assert(answered < 1000, `the backend took ${answered} ms, so the wait proves nothing`)
    assert(total >= 2000, `landed after ${total} ms`)
    assert(total < 3500, `landed only after ${total} ms`)
    return `backend ${answered} ms, reply on the board after ${total} ms`
  })

  await check('Stockfish replies are not delayed by the frontend', async () => {
    await injectGame(baseGame({ bot: 'stockfish', movetimeMs: 300 }))
    await playUci('e2e4')
    const at = await pliesReachedAt(2)
    const t = await lastBotTime()
    const gap = Math.round(at - t.answered)
    assert(gap < 300, `the move landed ${gap} ms after the answer`)
    return `on the board ${gap} ms after the answer`
  })

  await check('takeback during the wait cancels the reply', async () => {
    await injectGame(baseGame({ movetimeMs: 2000 }))
    await playUci('e2e4')
    await waitAnswered()
    const calls = botCalls.length
    await clickToolbar('Takeback')
    await waitFor((x) => x.plies === 0 && !x.thinking, 'takeback')
    await sleep(2300)
    const s = await state()
    assert(s.plies === 0 && !s.thinking, JSON.stringify(s))
    same(botCalls.length, calls, 'no new bot request')
    // and the game goes on normally
    await playUci('d2d4')
    await waitFor((x) => x.plies === 2, 'reply after the takeback', 6000)
    same(lastCall().body.moves, ['d2d4'], 'moves after the takeback')
  })

  await check('resigning during the wait cancels the reply', async () => {
    await injectGame(baseGame({ movetimeMs: 2000 }))
    await playUci('e2e4')
    await waitAnswered()
    await clickToolbar('Resign')
    await page.locator('[data-testid="play-resign-confirm"]').click()
    await waitFor((x) => x.over, 'resigned')
    await sleep(2300)
    const s = await state()
    assert(s.plies === 1 && s.over, JSON.stringify(s))
  })

  await check('a new game during the wait: the old reply never lands in it', async () => {
    await injectGame(baseGame({ movetimeMs: 2000 }))
    await playUci('e2e4')
    await waitAnswered()
    const old = (await state()).id
    await openNewGameDialog()
    await page.locator(`${DIALOG} button[data-color="white"]`).click()
    await startFromDialog()
    await sleep(2300)
    const s = await state()
    assert(s.id !== old && s.plies === 0 && !s.thinking, JSON.stringify(s))
  })

  await check('leaving the tab during the wait cancels it; coming back asks again and the move lands once', async () => {
    await injectGame(baseGame({ movetimeMs: 2000 }))
    await playUci('e2e4')
    await waitAnswered()
    await page.locator('.nav-item', { hasText: 'Learn' }).click()
    await sleep(2300)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('play-game-v1')))
    same(saved.sans, ['e4'], 'no reply while away')
    const calls = botCalls.length
    await gotoPlay()
    await waitFor((x) => x.plies === 2, 'reply after coming back', 6000)
    same(botCalls.length, calls + 1, 'one new request')
    same(lastCall().body.moves, ['e2e4'], 'moves')
    await sleep(600)
    same((await state()).plies, 2, 'plies')
  })

  await check('reload on the bot\'s turn resumes the game and Maia replies with the full history', async () => {
    await injectGame(baseGame({ elo: 1800, studentColor: 'black', sans: ['e4', 'c5', 'Nf3', 'd6'] }))
    const s = await waitFor((x) => x.plies === 5 && !x.thinking, 'bot reply on resume')
    assert(s.orientation === 'black', `orientation ${s.orientation}`)
    same(lastCall().body.moves, ['e2e4', 'c7c5', 'g1f3', 'd7d6'], 'moves')
    same(lastCall().body.elo, 1800, 'elo')
    await reload()
    const t = await waitFor((x) => x.id === s.id, 'same game after reload')
    assert(t.plies === 5 && t.bot === 'maia', JSON.stringify(t))
    const bar = await page.locator(BOT_BAR).innerText()
    assert(bar.includes('Maia') && bar.includes('1800'), bar)
    return `${s.fen}`
  })

  // ---------------- the end of a game
  await check('resign dialog, game-over text, last game and the names Review receives say Maia (1500)', async () => {
    await injectGame(baseGame({ elo: 1500 }))
    await clickToolbar('Resign')
    const dialog = await page.locator('.ui-modal', { hasText: 'Resign?' }).innerText()
    assert(dialog.includes('Resign this game against Maia (1500)?'), dialog)
    await page.locator('[data-testid="play-resign-confirm"]').click()
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    const over = await page.locator('[data-testid="play-over"]').innerText()
    assert(over.includes('Maia won') && over.includes('vs Maia (1500)') && !over.includes('Stockfish'), over)
    same(await page.locator(`${STATUS} .grow`).innerText(), 'Maia won by resignation', 'status line')
    const lg = await page.evaluate(() => JSON.parse(localStorage.getItem('last-game-v1')))
    same(lg.players, { white: 'You', black: 'Maia (1500)' }, 'last game players')
    await shot('05-game-over')
    return over.replace(/\s+/g, ' ')
  })

  await check('rematch keeps Maia and its rating and swaps colours', async () => {
    const before = (await state()).id
    await page.locator('[data-testid="play-over-rematch"]').click()
    const s = await waitFor((x) => x.id !== before, 'rematch')
    assert(s.bot === 'maia' && s.orientation === 'black', JSON.stringify(s))
    await waitFor((x) => x.plies === 1, 'Maia opens as White', 6000)
    same([lastCall().body.bot, lastCall().body.elo], ['maia', 1500], 'rematch request')
  })

  await check('Review this game hands over the name Maia (1500)', async () => {
    await injectGame(baseGame({ sans: ['f3', 'e5', 'g4'], studentColor: 'black', elo: 1500 }))
    await waitFor((x) => x.turn === 'black' && !x.thinking, 'student turn')
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/review') && r.method() === 'POST', { timeout: 15000 })
    await playUci('d8h4')
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="play-over-review"]').click()
    await page.locator('[data-testid="review-start"]').click()
    const body = (await posted).postDataJSON()
    same(body.players, { white: 'Maia (1500)', black: 'You' }, 'review players')
  })
  await gotoPlay()

  // ---------------- opening lines
  await check('a game from the end of an opening line sends the whole line as history', async () => {
    await freshStart({ 'play-setup-v1': { color: 'white', bot: 'maia', maiaElo: 1600, movetimeMs: 300 } })
    const opening = await (await fetch(`${BASE}/api/openings/alien-gambit`)).json()
    const line = opening.lines.find((l) => l.id === 'alien-accepted-c5')
    await chooseOpening(FORM, 'alien-gambit', 'alien-accepted-c5', 'end')
    await shot('06-form-opening')
    await page.locator('[data-testid="play-start"]').click()
    await waitFor((x) => x.plies === line.sans.length + 1 && !x.thinking, 'the line played and Maia replied')
    const body = lastCall().body
    same(body.moves, ucisOf(line.sans), 'moves')
    same([body.bot, body.elo, body.start_fen], ['maia', 1600, START], 'request')
    await shot('07-opening-game')
    return `${body.moves.length} moves sent`
  })

  await check('hints mode: Maia follows the line without asking the backend, then plays from history', async () => {
    await freshStart({ 'play-setup-v1': { color: 'white', bot: 'maia', maiaElo: 1500, movetimeMs: 300 } })
    await chooseOpening(FORM, 'alien-gambit', 'alien-accepted-c5', 'hints')
    await page.locator('[data-testid="play-start"]').click()
    await waitFor((x) => Boolean(x.id) && x.plies === 0, 'hints game')
    const calls = botCalls.length
    await playUci('e2e4')
    await waitFor((x) => x.plies === 2 && !x.thinking, 'book reply')
    same(botCalls.length, calls, 'no bot request for a book reply')
    const text = await page.locator(`${TAB} .play-book`).innerText()
    assert(text.includes('Maia follows the line.'), text)
    await playUci('g1f3')
    await page.locator('[data-testid="play-anyway"]').waitFor({ timeout: 3000 })
    await page.locator('[data-testid="play-anyway"]').click()
    await waitFor((x) => x.plies === 4 && !x.thinking, 'Maia after leaving the book')
    same(lastCall().body.moves, ['e2e4', 'c7c6', 'g1f3'], 'moves')
    same(lastCall().body.bot, 'maia', 'bot')
  })

  await check('a saved game with its own start position sends that FEN as start_fen', async () => {
    const startFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'
    await injectGame(baseGame({ startFen, sans: ['Bb5'], movetimeMs: 300 }))
    await waitFor((x) => x.plies === 2 && !x.thinking, 'reply')
    same(lastCall().body.start_fen, startFen, 'start_fen')
    same(lastCall().body.moves, ['f1b5'], 'moves')
  })

  // ---------------- old data
  await check('a saved game from before Maia loads as Stockfish', async () => {
    const { bot: _bot, ...old } = baseGame({ sans: ['e4'], elo: 1500 })
    await injectGame(old)
    const s = await waitFor((x) => x.plies === 2 && !x.thinking, 'Stockfish reply')
    same(s.bot, 'stockfish', 'bot')
    const bar = await page.locator(BOT_BAR).innerText()
    assert(bar.includes('Stockfish 19') && bar.includes('1500'), bar)
    same(await page.locator(`${TAB} .panel-title`).innerText(), 'vs Stockfish 19', 'title')
    same(lastCall().body.bot ?? 'stockfish', 'stockfish', 'request bot')
    assert(!('moves' in lastCall().body), 'moves sent to Stockfish')
    same(lastCall().reply.strength.mode, 'uci_elo', 'strength')
    same(await page.locator(`${TAB} .play-strength`).innerText(), 'Limited to 1500 Elo', 'strength line')
  })

  await check('a setup from before Maia loads as Stockfish, with Maia at its default', async () => {
    await freshStart({ 'play-setup-v1': { color: 'black', elo: 900, movetimeMs: 300, useOpening: false, openingId: '', lineId: '__random__', openingMode: 'hints' } })
    same(await selectedBot(), 'stockfish', 'bot')
    same(await eloShown(), '900', 'Stockfish Elo')
    await page.locator(`${FORM} [data-bot="maia"]`).click()
    same(await eloShown(), '1500', 'Maia default')
  })

  await check('a stored Maia rating that is not one of the nets snaps to the nearest one', async () => {
    await injectGame(baseGame({ elo: 1534 }))
    const bar = await page.locator(BOT_BAR).innerText()
    assert(bar.includes('1500'), bar)
    await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 2600 } })
    same(await eloShown(), '1900', 'clamped rating')
  })

  // ---------------- Maia not installed
  const maiaMissing = async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.maia = { available: false, ratings: [], path: 'C:\\missing\\lc0.exe' }
    await route.fulfill({ response: res, json: body })
  }

  await check('while the health check is pending nothing says "not installed"', async () => {
    await resetStorage({ 'play-setup-v1': { bot: 'maia', maiaElo: 1700, color: 'white' } })
    await page.route('**/api/health', async (route) => {
      await new Promise((r) => setTimeout(r, 2200))
      await maiaMissing(route)
    })
    await reload('domcontentloaded')
    try {
      assert((await page.locator(`${FORM} [data-testid="play-maia-install"]`).count()) === 0, 'install note before the health answer')
      assert(await page.locator(`${FORM} button[data-bot="maia"]`).isEnabled(), 'Maia card disabled before the health answer')
      same(await selectedBot(), 'maia', 'stored choice while unknown')
      await page.locator(`${FORM} [data-testid="play-maia-install"]`).waitFor({ timeout: 6000 })
      same(await selectedBot(), 'stockfish', 'after the health answer')
    } finally {
      await page.unroute('**/api/health')
    }
  })

  await check('not installed: the card is disabled, says how to install, and the form is not stuck', async () => {
    await page.route('**/api/health', maiaMissing)
    await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 1700, elo: 1900, color: 'white', movetimeMs: 300 } })
    await page.locator(`${FORM} [data-testid="play-maia-install"]`).waitFor({ timeout: 5000 })
    await shot('08-not-installed')
    const card = page.locator(`${FORM} [data-bot="maia"]`)
    same(await card.getAttribute('aria-disabled'), 'true', 'aria-disabled')
    const note = await page.locator(`${FORM} [data-testid="play-maia-install"]`).innerText()
    assert(note.includes(String.raw`python tools\install_maia.py`) && note.includes('restart'), note)
    same(await selectedBot(), 'stockfish', 'falls back to Stockfish')
    same(await eloShown(), '1900', 'shows the Stockfish Elo')
    same(await page.locator(`${TAB} .panel-title`).innerText(), 'Play vs Stockfish 19', 'title')
    await card.click({ force: true })
    same(await selectedBot(), 'stockfish', 'a click on the card does nothing')
    await page.locator('[data-testid="play-start"]').click()
    const g = await waitFor((x) => Boolean(x.id), 'game')
    same(g.bot, 'stockfish', 'the game is against Stockfish')
    await playUci('e2e4')
    await waitFor((x) => x.plies === 2 && !x.thinking, 'Stockfish reply')
    same(lastCall().reply.strength.mode, 'uci_elo', 'strength')
    assert(lastCall().body.bot !== 'maia', 'asked Maia')
    await openNewGameDialog()
    await page.locator(`${DIALOG} [data-testid="play-maia-install"]`).waitFor({ timeout: 3000 })
    await shot('09-not-installed-dialog')
    await page.locator(`${DIALOG} button`, { hasText: 'Cancel' }).click()
    await page.unroute('**/api/health')
  })

  await check('a saved Maia game with Maia gone shows the error style and Retry; Retry works once it is back', async () => {
    const answer = { fulfill: true }
    await page.route('**/api/bot/move', async (route) => {
      if (answer.fulfill) await route.fulfill({ status: 503, json: { detail: MISSING_DETAIL } })
      else await route.continue()
    })
    await page.route('**/api/health', maiaMissing)
    expected503 = true
    try {
      await injectGame(baseGame({ sans: ['e4'], movetimeMs: 300 }))
      await page.locator(`${STATUS}.error`).waitFor({ timeout: 5000 })
      const text = await page.locator(STATUS).innerText()
      assert(text.includes('install_maia.py') && text.includes('Maia is unavailable'), text)
      const s = await state()
      assert(s.plies === 1 && !s.thinking && s.bot === 'maia', JSON.stringify(s))
      const bar = await page.locator(BOT_BAR).innerText()
      assert(bar.includes('Maia'), bar)
      assert((await overflowProblems()).length === 0, JSON.stringify(await overflowProblems()))
      await shot('10-missing-retry')
      answer.fulfill = false
      await page.locator(`${STATUS} button`, { hasText: 'Retry' }).click()
      await waitFor((x) => x.plies === 2 && !x.thinking, 'reply after Retry', 6000)
      assert((await page.locator(`${STATUS}.error`).count()) === 0, 'error still shown')
      return text.replace(/\s+/g, ' ')
    } finally {
      expected503 = false
      await page.unroute('**/api/bot/move')
      await page.unroute('**/api/health')
    }
  })

  // ---------------- a backend that does not report Maia, or only some of its nets
  const patchHealth = (patch) => async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    patch(body)
    await route.fulfill({ response: res, json: body })
  }
  const twoNets = patchHealth((body) => {
    body.maia = { ...body.maia, available: true, ratings: [1500, 1700] }
  })
  async function resignInjectedGame(game) {
    await injectGame(game)
    await clickToolbar('Resign')
    await page.locator('[data-testid="play-resign-confirm"]').click()
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
  }
  async function rematchOpensTheDialog() {
    const calls = botCalls.length
    const before = await state()
    await page.locator('[data-testid="play-over-rematch"]').click()
    await page.locator(DIALOG).waitFor({ timeout: 3000 })
    await sleep(400)
    const s = await state()
    same([s.id, s.plies], [before.id, before.plies], 'the game did not change')
    same(botCalls.length, calls, 'no bot request')
  }

  await check('a health answer without maia (an older backend) leaves the Play tab working', async () => {
    await page.route('**/api/health', patchHealth((body) => delete body.maia))
    try {
      await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 1500, elo: 1400, color: 'white', movetimeMs: 300 } })
      await page.locator(`${FORM} [data-testid="play-maia-install"]`).waitFor({ timeout: 5000 })
      same(await selectedBot(), 'stockfish', 'bot')
      await page.locator('[data-testid="play-start"]').click()
      await waitFor((x) => Boolean(x.id), 'game')
      await playUci('e2e4')
      await waitFor((x) => x.plies === 2 && !x.thinking, 'Stockfish reply')
    } finally {
      await page.unroute('**/api/health')
    }
  })

  await check('Rematch with Maia not installed opens the New game dialog instead of a game that cannot start', async () => {
    await page.route('**/api/health', maiaMissing)
    try {
      await resignInjectedGame(baseGame({ elo: 1500 }))
      await rematchOpensTheDialog()
      await page.locator(`${DIALOG} [data-testid="play-maia-install"]`).waitFor({ timeout: 3000 })
      await page.locator(`${DIALOG} button`, { hasText: 'Cancel' }).click()
    } finally {
      await page.unroute('**/api/health')
    }
  })

  await check('with only some nets installed the form offers just those, and a game uses one of them', async () => {
    await page.route('**/api/health', twoNets)
    try {
      await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 1300, color: 'white', movetimeMs: 300 } })
      await page.locator(`${FORM} [data-testid="play-maia-partial"]`).waitFor({ timeout: 5000 })
      same(await selectedBot(), 'maia', 'bot')
      same(await eloShown(), '1500', 'snapped to the nearest installed rating')
      same(await page.locator(`${FORM} .play-elo-presets button:not([disabled])`).allInnerTexts(), ['1500', '1700'], 'enabled presets')
      await page.locator(`${FORM} .play-elo-slider input[type=range]`).focus()
      await page.keyboard.press('ArrowRight')
      same(await eloShown(), '1700', 'the slider moves to the next installed rating')
      await page.keyboard.press('Home')
      same(await eloShown(), '1500', 'Home')
      await page.keyboard.press('End')
      same(await eloShown(), '1700', 'End')
      await shot('11-partial-install')
      await page.locator('[data-testid="play-start"]').click()
      await waitFor((x) => Boolean(x.id), 'game')
      await playUci('e2e4')
      await waitFor((x) => x.plies === 2 && !x.thinking, 'Maia reply')
      same(lastCall().body.elo, 1700, 'request rating')
    } finally {
      await page.unroute('**/api/health')
    }
  })

  await check('Rematch at a rating whose net is not installed opens the New game dialog', async () => {
    await page.route('**/api/health', twoNets)
    try {
      await resignInjectedGame(baseGame({ elo: 1300 }))
      await rematchOpensTheDialog()
      await page.locator(`${DIALOG} button`, { hasText: 'Cancel' }).click()
    } finally {
      await page.unroute('**/api/health')
    }
  })

  // ---------------- keyboard, wording and contrast
  const activeAttr = (name) => page.evaluate((n) => document.activeElement?.getAttribute(n) ?? null, name)

  await check('the New game dialog keeps keyboard focus, so the slider and presets work from the keyboard', async () => {
    await injectGame(baseGame({ sans: ['e4', 'c6'], movetimeMs: 300 }))
    await openNewGameDialog()
    same(await page.evaluate(() => document.activeElement?.classList.contains('ui-modal')), true, 'the dialog takes focus when it opens')
    await page.locator(`${DIALOG} button[data-bot="maia"]`).click()
    await page.locator(`${DIALOG} button[data-elo="1300"]`).click()
    await page.locator(`${DIALOG} .play-elo-slider input[type=range]`).focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    same(await eloShown(DIALOG), '1600', 'three steps')
    same(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'focus stays on the slider')
    await page.keyboard.press('ArrowLeft')
    same(await eloShown(DIALOG), '1500', 'one step back')
    await page.locator(`${DIALOG} button[data-elo="1700"]`).focus()
    await page.keyboard.press('Enter')
    same(await eloShown(DIALOG), '1700', 'preset')
    same(await activeAttr('data-elo'), '1700', 'focus stays on the preset')
    await page.keyboard.press('Escape')
    await page.locator(DIALOG).waitFor({ state: 'detached', timeout: 3000 })
  })

  await check('keyboard: arrows move through the radio groups, one Tab stop each, and the slider shows focus', async () => {
    await freshStart({ 'play-setup-v1': { bot: 'stockfish', elo: 1500, color: 'white', movetimeMs: 800 } })
    const card = `${FORM} button[data-bot="stockfish"]`
    await page.locator(card).focus()
    await page.keyboard.press('ArrowDown')
    same(await selectedBot(), 'maia', 'ArrowDown')
    same(await activeAttr('data-bot'), 'maia', 'focus follows')
    await page.keyboard.press('ArrowUp')
    same(await selectedBot(), 'stockfish', 'ArrowUp')
    same(await page.locator(`${FORM} button[data-bot]`).evaluateAll((els) => els.map((e) => e.tabIndex)), [0, -1, -1], 'tab stops')
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => {
      const el = document.activeElement
      const s = getComputedStyle(el)
      return [el.getAttribute('type'), s.outlineStyle, s.outlineWidth]
    })
    same(ring, ['range', 'solid', '2px'], 'Tab goes on to the slider, which shows a ring')
    await page.locator(`${FORM} button[data-color="white"]`).focus()
    await page.keyboard.press('ArrowRight')
    same(await activeAttr('data-color'), 'random', 'colour group')
    same(await page.locator(`${FORM} button[data-color="random"]`).getAttribute('aria-checked'), 'true', 'colour selected')
  })

  await check('Elo is explained in plain words and the Stockfish text has no engine jargon', async () => {
    await freshStart({ 'play-setup-v1': { bot: 'stockfish', elo: 1500, color: 'white', movetimeMs: 300 } })
    const explained = page.locator(`${FORM} [data-testid="play-elo-explainer"]`)
    const text = await explained.innerText()
    assert(text.includes('Elo is a chess rating') && text.includes('higher means stronger'), text)
    assert(text.includes('Lichess ratings run higher than chess.com'), text)
    for (const elo of ['800', '2000']) {
      await page.locator(`${FORM} button[data-elo="${elo}"]`).click()
      const form = await page.locator(FORM).innerText()
      assert(!/UCI_|Skill Level|mixing/.test(form), form)
    }
    assert(await page.locator(`${FORM} .play-setup-label`, { hasText: 'Elo' }).isVisible(), 'the control is not labelled Elo')
    await page.locator(`${FORM} [data-bot="maia"]`).click()
    assert(await explained.isVisible(), 'not shown for Maia')
    await shot('12-elo-explained')
  })

  await check('the notes under the controls are readable (contrast at least 4.5:1)', async () => {
    await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 1500, color: 'white', movetimeMs: 300 } })
    for (const id of ['play-strength-note', 'play-movetime-note', 'play-elo-explainer']) {
      const ratio = await page.locator(`${FORM} [data-testid="${id}"]`).evaluate((el) => {
        const rgb = (text) => text.match(/[\d.]+/g).map(Number)
        const lum = ([r, g, b]) => {
          const f = (v) => {
            const c = v / 255
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        let box = el
        while (rgb(getComputedStyle(box).backgroundColor)[3] === 0 || getComputedStyle(box).backgroundColor === 'transparent') box = box.parentElement
        const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(getComputedStyle(box).backgroundColor))]
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
      assert(ratio >= 4.5, `${id}: ${ratio.toFixed(2)}:1`)
    }
  })

  // ---------------- the board after the page moves it
  for (const [width, height, input] of [
    [390, 844, 'drag'],
    [800, 700, 'click'],
  ]) {
    await check(`at ${width}x${height} the board takes moves right after Start, without a scroll (${input})`, async () => {
      await page.setViewportSize({ width, height })
      await freshStart({ 'play-setup-v1': { bot: 'stockfish', elo: 1500, color: 'white', movetimeMs: 300 } })
      await page.locator('[data-testid="play-start"]').click()
      await waitFor((x) => Boolean(x.id) && x.plies === 0, 'game')
      if (input === 'drag') await playUci('e2e4')
      else {
        const box = await page.locator(`${BOARD} cg-board`).boundingBox()
        const a = center(box, 'e2', 'white')
        const b = center(box, 'e4', 'white')
        await page.mouse.click(a.x, a.y)
        await page.mouse.click(b.x, b.y)
      }
      await waitFor((x) => x.plies >= 1, 'the move was accepted', 3000)
    })
  }
  await page.setViewportSize({ width: 1366, height: 768 })

  // ---------------- layout
  const sizes = [
    ['1366x768', 1366, 768],
    ['1100x760', 1100, 760],
    ['1920x1080', 1920, 1080],
    ['phone-390x844', 390, 844],
    ['phone-360x740', 360, 740],
  ]
  for (const [name, width, height] of sizes) {
    await check(`layout at ${name}: form, dialog and game do not overflow`, async () => {
      await page.setViewportSize({ width, height })
      await freshStart({ 'play-setup-v1': { bot: 'maia', maiaElo: 1500, color: 'white', movetimeMs: 800, useOpening: true, openingId: 'alien-gambit', lineId: '__random__', openingMode: 'hints' } })
      await page.locator(`${FORM} .play-mode-group`).nth(1).waitFor({ timeout: 8000 })
      await sleep(250)
      const form = await overflowProblems()
      assert(form.length === 0, `form: ${form.join('; ')}`)
      await page.screenshot({ path: `${SHOTS}/play-maia-layout-${name}-form.png` })

      await page.route('**/api/health', maiaMissing)
      await reload()
      await page.locator(`${FORM} [data-testid="play-maia-install"]`).waitFor({ timeout: 5000 })
      const missing = await overflowProblems()
      await page.unroute('**/api/health')
      assert(missing.length === 0, `not installed: ${missing.join('; ')}`)
      await page.screenshot({ path: `${SHOTS}/play-maia-layout-${name}-missing.png` })

      await injectGame(baseGame({ sans: ['e4', 'c6', 'd4', 'd5'], movetimeMs: 300 }))
      await sleep(250)
      const game = await overflowProblems()
      assert(game.length === 0, `game: ${game.join('; ')}`)
      await page.screenshot({ path: `${SHOTS}/play-maia-layout-${name}-game.png` })

      await openNewGameDialog()
      await page.locator(`${DIALOG} [data-bot="maia"]`).click()
      await sleep(250)
      const dialog = await overflowProblems()
      assert(dialog.length === 0, `dialog: ${dialog.join('; ')}`)
      const box = await page.locator('.ui-modal').boundingBox()
      assert(box && box.y >= 0 && box.y + box.height <= height, `dialog leaves the window: ${JSON.stringify(box)}`)
      const start = await page.locator(`${DIALOG} [data-testid="play-start"]`).boundingBox()
      assert(start && start.y + start.height <= height, 'Start button below the window')
      await page.screenshot({ path: `${SHOTS}/play-maia-layout-${name}-dialog.png` })
      await page.locator(`${DIALOG} button`, { hasText: 'Cancel' }).click()
    })
  }
  await page.setViewportSize({ width: 1366, height: 768 })
} finally {
  console.log('\nbot calls:', botCalls.length)
  if (consoleErrors.length) {
    console.log('CONSOLE ERRORS:')
    for (const e of consoleErrors) console.log('  ', e)
  } else console.log('console errors: none')
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exitCode = failed || consoleErrors.length ? 1 : 0
}
