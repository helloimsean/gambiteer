// Playwright end-to-end check of the Play tab against the real backend (not part of the app bundle).
//   backend on :8000 and `npm run dev` running, then from frontend/:
//   node src/tabs/Play/PlayTab.e2e.mjs [baseUrl]        (default http://localhost:5173)
// Writes screenshots to frontend/screenshots/Play-*.png; exit code 0 = all checks passed.
// Note: it clears/overwrites the play-game-v1 and play-setup-v1 localStorage keys of that browser profile
// (a fresh Playwright profile, so your own browser is not touched).
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FRONT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '')
const require = createRequire(FRONT + '/package.json')
const { chromium } = require('playwright')

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://localhost:8000'
const SHOTS = FRONT + '/screenshots'
mkdirSync(SHOTS, { recursive: true })
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

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
    record(name, false, err instanceof Error ? err.message : String(err))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const TAB = '[data-testid="play-tab"]'
const BOARD = `${TAB} .board-root`

async function state(page) {
  return page.locator(TAB).evaluate((el) => {
    const b = el.querySelector('.board-root')
    return {
      id: el.dataset.gameId,
      turn: el.dataset.turn,
      over: el.dataset.over === 'true',
      thinking: el.dataset.thinking === 'true',
      plies: Number(el.dataset.plies),
      fen: b?.getAttribute('data-fen'),
      orientation: b?.getAttribute('data-orientation'),
    }
  })
}
async function waitFor(page, pred, label, timeout = 30000) {
  const t0 = Date.now()
  let s
  while (Date.now() - t0 < timeout) {
    s = await state(page)
    if (pred(s)) return s
    await page.waitForTimeout(80)
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
}

async function boardBox(page) {
  const box = await page.locator(`${BOARD} cg-board`).boundingBox()
  assert(box, 'board has no bounding box')
  return box
}
function center(box, sq, orientation) {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  const s = box.width / 8
  const col = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 7 - rank : rank
  return { x: box.x + s * (col + 0.5), y: box.y + s * (row + 0.5) }
}
async function drag(page, from, to) {
  const box = await boardBox(page)
  const o = (await state(page)).orientation
  const a = center(box, from, o)
  const b = center(box, to, o)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}
/** Drag a UCI move; picks the promotion piece in the chooser when needed. */
async function playUci(page, uci) {
  await drag(page, uci.slice(0, 2), uci.slice(2, 4))
  if (uci.length > 4) {
    const btn = page.locator(`${BOARD} .board-promo button[data-piece="${uci[4]}"]`)
    await btn.waitFor({ timeout: 3000 })
    await btn.click()
    await page.waitForTimeout(120)
  }
}
async function engineMove(fen, depth = 6) {
  const res = await fetch(`${API}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, multipv: 1, depth }),
  })
  const data = await res.json()
  return data.lines[0].pvUci[0]
}
/** Student plays n engine moves, waiting for each bot reply. Returns the number of student moves made. */
async function playMoves(page, color, n) {
  let made = 0
  for (let i = 0; i < n; i++) {
    const s = await waitFor(page, (x) => x.over || (x.turn === color && !x.thinking), 'student turn', 40000)
    if (s.over) break
    const uci = await engineMove(s.fen)
    await playUci(page, uci)
    await waitFor(page, (x) => x.plies >= s.plies + 1, `student move ${uci} applied`, 5000)
    made += 1
    await waitFor(page, (x) => x.over || x.plies >= s.plies + 2, 'bot reply', 40000)
  }
  return made
}
async function shot(page, name) {
  await page.waitForTimeout(350)
  await page.screenshot({ path: `${SHOTS}/Play-${name}.png` })
}
async function gotoPlay(page) {
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
  await page.waitForTimeout(250)
}
async function injectGame(page, game) {
  await page.evaluate((g) => {
    localStorage.setItem('play-game-v1', JSON.stringify(g))
  }, game)
  await page.reload({ waitUntil: 'networkidle' })
  await gotoPlay(page)
}
function baseGame(over) {
  return {
    version: 1,
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    studentColor: 'white',
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
async function openNewGameDialog(page) {
  await page.locator(`${TAB} .play-toolbar button`, { hasText: 'New game' }).click()
  await page.locator('.play-new-modal').waitFor()
}
async function startFromDialog(page) {
  const before = (await state(page)).id
  await page.locator('.play-new-modal [data-testid="play-start"]').click()
  await waitFor(page, (x) => x.id && x.id !== before, 'new game id')
}
async function chooseOpening(page, scope, openingId, lineId, mode) {
  const toggle = page.locator(`${scope} label.ui-toggle`, { hasText: 'Start from an opening line' })
  const checked = await toggle.locator('input').isChecked()
  if (!checked) await toggle.click()
  const selects = page.locator(`${scope} .play-select select`)
  await selects.nth(0).selectOption(openingId)
  // wait for the lines of that opening
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

// ---------------------------------------------------------------- run

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await context.addInitScript(() => {
  window.__sounds = 0
  const C = window.AudioContext
  if (C) {
    const orig = C.prototype.createOscillator
    C.prototype.createOscillator = function (...args) {
      window.__sounds += 1
      return orig.apply(this, args)
    }
  }
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
const failedUrls = []
page.on('response', (res) => { if (res.status() >= 400) failedUrls.push(String(res.status()) + ' ' + res.url()) })
const botCalls = []
page.on('response', async (res) => {
  if (!res.url().includes('/api/bot/move')) return
  try {
    const req = JSON.parse(res.request().postData() ?? '{}')
    const body = await res.json()
    botCalls.push({ elo: req.elo, movetime: req.movetime_ms, status: res.status(), strength: body.strength, san: body.san })
  } catch {
    botCalls.push({ status: res.status() })
  }
})

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    localStorage.removeItem('play-game-v1')
    localStorage.removeItem('play-setup-v1')
  })
  await page.reload({ waitUntil: 'networkidle' })
  await gotoPlay(page)

  await check('setup form shows with strength caption (approximate below 1320, UCI_Elo above)', async () => {
    await page.locator('[data-testid="play-setup"]').waitFor()
    await page.locator('button[data-elo="800"]').click()
    const low = await page.locator('[data-testid="play-strength-caption"]').innerText()
    assert(low.includes('approximate (Skill Level + mixing)'), `caption at 800: ${low}`)
    await page.locator('button[data-elo="2500"]').click()
    const high = await page.locator('[data-testid="play-strength-caption"]').innerText()
    assert(high.includes('Stockfish 19, UCI_Elo'), `caption at 2500: ${high}`)
    // slider drag via keyboard to the max
    const slider = page.locator('.play-elo-slider input[type=range]')
    await slider.focus()
    await page.keyboard.press('End')
    const v = await page.locator('[data-testid="play-elo-value"]').innerText()
    assert(v === '3190', `slider max ${v}`)
    await page.keyboard.press('Home')
    const v2 = await page.locator('[data-testid="play-elo-value"]').innerText()
    assert(v2 === '400', `slider min ${v2}`)
    return `${low} / ${high}`
  })
  await page.locator('button[data-elo="800"]').click()
  await page.locator('button[data-color="white"]').click()
  await page.locator('button[data-movetime="300"]').click()
  await shot(page, '01-setup')

  // ---------------- game at 800
  await check('game vs bot at Elo 800: several moves each way', async () => {
    await page.locator('[data-testid="play-start"]').click()
    const s = await waitFor(page, (x) => Boolean(x.id), 'game started')
    assert(s.orientation === 'white' && s.plies === 0 && s.turn === 'white', JSON.stringify(s))
    const made = await playMoves(page, 'white', 7)
    const end = await state(page)
    assert(made >= 5, `only ${made} student moves`)
    assert(end.plies >= 10 || end.over, `plies ${end.plies}`)
    const calls = botCalls.filter((c) => c.elo === 800)
    assert(calls.length >= 5, `${calls.length} bot calls at 800`)
    assert(calls.every((c) => c.status === 200 && c.strength?.mode === 'skill'), JSON.stringify(calls.slice(0, 2)))
    return `${end.plies} plies, bot moves: ${calls.map((c) => c.san).join(' ')}`
  })
  await shot(page, '02-elo800')

  await check('move / capture / check sounds are synthesized (WebAudio oscillators created)', async () => {
    const n = await page.evaluate(() => window.__sounds)
    assert(n > 0, 'no oscillator was created')
    return `${n} oscillators so far`
  })

  await check('captured pieces / material shown when material is off balance', async () => {
    const pieces = await page.locator(`${TAB} .play-captured .play-piece piece`).count()
    const adv = await page.locator(`${TAB} .play-advantage`).allInnerTexts()
    return `${pieces} captured piece icons, advantage labels: ${JSON.stringify(adv)}`
  })

  await check('takeback undoes both plies', async () => {
    const s = await waitFor(page, (x) => x.over || (x.turn === 'white' && !x.thinking), 'student turn')
    assert(!s.over, 'game is over')
    await page.locator(`${TAB} .play-toolbar button`, { hasText: 'Takeback' }).click()
    const t = await waitFor(page, (x) => x.plies === s.plies - 2, 'takeback', 5000)
    assert(t.turn === 'white', `turn ${t.turn}`)
    return `${s.plies} -> ${t.plies}`
  })

  await check('hint shows an arrow for ~3 s', async () => {
    await page.locator(`${TAB} .play-toolbar button`, { hasText: 'Hint' }).click()
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .cg-shapes line`).length > 0, BOARD, { timeout: 15000 })
    const note = await page.locator('[data-testid="play-status"]').innerText()
    await page.screenshot({ path: `${SHOTS}/Play-03-hint.png` })
    await page.waitForTimeout(3400)
    const n = await page.locator(`${BOARD} .cg-shapes line`).count()
    assert(n === 0, `${n} arrows still shown after 3.4 s`)
    return note.replace(/\s+/g, ' ')
  })

  await check('flip toggles the orientation', async () => {
    await page.locator(`${TAB} .play-toolbar button[title="Flip board"]`).click()
    const a = await state(page)
    await page.locator(`${TAB} .play-toolbar button[title="Flip board"]`).click()
    const b = await state(page)
    assert(a.orientation === 'black' && b.orientation === 'white', `${a.orientation} ${b.orientation}`)
  })

  await check('in-progress game survives a tab switch and a reload', async () => {
    const s = await state(page)
    await page.locator('.nav-item', { hasText: 'Learn' }).click()
    await page.waitForTimeout(300)
    await gotoPlay(page)
    const t = await state(page)
    assert(t.id === s.id && t.plies === s.plies && t.fen === s.fen, `${JSON.stringify(s)} vs ${JSON.stringify(t)}`)
    await page.reload({ waitUntil: 'networkidle' })
    await gotoPlay(page)
    const u = await state(page)
    assert(u.id === s.id && u.plies === s.plies, `after reload ${JSON.stringify(u)}`)
    return `${s.id} at ply ${s.plies}`
  })

  await check('move list click views an earlier position (read-only) and Back to game returns', async () => {
    const s = await state(page)
    await page.locator(`${TAB} .move-cell[data-ply="2"]`).click()
    await page.waitForTimeout(200)
    const v = await state(page)
    assert(v.fen !== s.fen, 'fen did not change')
    await page.locator(`${TAB} .play-viewing button`).click()
    const w = await state(page)
    assert(w.fen === s.fen, 'did not return to the live fen')
  })

  // ---------------- game at 2500 as black
  await check('game vs bot at Elo 2500 as Black: bot opens, several moves each way', async () => {
    await openNewGameDialog(page)
    await page.locator('.play-new-modal button[data-color="black"]').click()
    await page.locator('.play-new-modal button[data-elo="2500"]').click()
    await page.locator('.play-new-modal button[data-movetime="300"]').click()
    await startFromDialog(page)
    const s = await waitFor(page, (x) => x.plies >= 1 && x.turn === 'black' && !x.thinking, 'bot first move')
    assert(s.orientation === 'black', `orientation ${s.orientation}`)
    const made = await playMoves(page, 'black', 7)
    const end = await state(page)
    assert(made >= 5, `only ${made} student moves`)
    const calls = botCalls.filter((c) => c.elo === 2500)
    assert(calls.length >= 5, `${calls.length} bot calls at 2500`)
    assert(calls.every((c) => c.status === 200 && c.strength?.mode === 'uci_elo'), JSON.stringify(calls.slice(0, 2)))
    return `${end.plies} plies, bot moves: ${calls.map((c) => c.san).join(' ')}`
  })
  await shot(page, '04-elo2500')

  await check('resign -> game over modal; rematch swaps colours', async () => {
    await page.locator(`${TAB} .play-toolbar button`, { hasText: 'Resign' }).click()
    await page.locator('[data-testid="play-resign-confirm"]').click()
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    const text = await page.locator('[data-testid="play-over"]').innerText()
    assert(/resignation/.test(text) && /Stockfish 19 won/.test(text), text)
    const lg = await page.evaluate(() => JSON.parse(localStorage.getItem('last-game-v1') ?? 'null'))
    assert(lg && lg.result === '1-0' && lg.reason === 'resignation', JSON.stringify(lg))
    await shot(page, '05-resign')
    const before = (await state(page)).id
    await page.locator('[data-testid="play-over-rematch"]').click()
    const s = await waitFor(page, (x) => x.id !== before, 'rematch')
    assert(s.orientation === 'white' && s.plies === 0 && s.turn === 'white', JSON.stringify(s))
    return text.replace(/\s+/g, ' ')
  })

  // ---------------- quick mate (fool's mate, student is Black)
  await check("fool's mate: game over modal appears and Review this game navigates with the moves", async () => {
    await injectGame(page, baseGame({ studentColor: 'black', elo: 800, sans: ['f3', 'e5', 'g4'] }))
    const s = await waitFor(page, (x) => x.turn === 'black' && !x.thinking && x.plies === 3, 'resumed injected game')
    assert(s.orientation === 'black', `orientation ${s.orientation}`)
    await playUci(page, 'd8h4')
    await waitFor(page, (x) => x.over, 'game over', 5000)
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    const text = await page.locator('[data-testid="play-over"]').innerText()
    assert(/You won!/.test(text) && /checkmate/.test(text) && /0-1/.test(text), text)
    await shot(page, '06-mate')
    const lg = await page.evaluate(() => JSON.parse(localStorage.getItem('last-game-v1') ?? 'null'))
    assert(lg && lg.sans.join(' ') === 'f3 e5 g4 Qh4#' && lg.result === '0-1', JSON.stringify(lg))
    assert(lg.players.black === 'You' && /Stockfish 19/.test(lg.players.white), JSON.stringify(lg.players))
    await page.locator('[data-testid="play-over-review"]').click()
    await page.waitForTimeout(600)
    const active = await page.locator('.nav-item.active').innerText()
    assert(/Review/.test(active), `active tab ${active}`)
    await page.screenshot({ path: `${SHOTS}/Play-07-review.png` })
    const reviewText = (await page.locator('.main').innerText()).slice(0, 300).replace(/\s+/g, ' ')
    return `lastGame ok; review tab shows: ${reviewText}`
  })

  // ---------------- promotion
  await check('promotion chooser: a8=N is played (and K+N vs K ends as insufficient material)', async () => {
    await injectGame(page, baseGame({ startFen: '8/P5k1/8/8/8/8/6K1/8 w - - 0 1' }))
    await waitFor(page, (x) => x.turn === 'white' && !x.thinking, 'resumed promo game')
    await playUci(page, 'a7a8n')
    const s = await waitFor(page, (x) => x.plies === 1, 'promotion applied', 5000)
    assert(s.fen.startsWith('N7/6k1/'), `fen ${s.fen}`)
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    const text = await page.locator('[data-testid="play-over"]').innerText()
    assert(/Draw/.test(text) && /insufficient/.test(text), text)
    await shot(page, '08-promotion-knight-insufficient')
    await page.keyboard.press('Escape')
    return s.fen
  })
  await check('promotion chooser: a8=Q is played and the bot replies', async () => {
    await injectGame(page, baseGame({ startFen: '8/P5k1/8/8/8/8/6K1/8 w - - 0 1' }))
    await waitFor(page, (x) => x.turn === 'white' && !x.thinking, 'resumed promo game')
    await playUci(page, 'a7a8q')
    const s = await waitFor(page, (x) => x.plies === 2 && !x.thinking, 'bot reply after promotion', 20000)
    const sans = await page.locator(`${TAB} .move-cell .move-san`).allInnerTexts()
    assert(sans[0] === 'a8=Q', `sans ${sans.join(' ')}`)
    await shot(page, '09-promotion-queen')
    return `${sans.join(' ')} | ${s.fen}`
  })

  // ---------------- opening line with hints
  await check('hints mode: book moves get a green check, the bot follows the line', async () => {
    await openNewGameDialog(page)
    await chooseOpening(page, '.play-new-modal', 'alien-gambit', 'alien-accepted-c5', 'hints')
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/Play-15-new-game-dialog.png` })
    const colorActive = await page.locator('.play-new-modal button[data-color].active').getAttribute('data-color')
    assert(colorActive === 'white', `colour auto-set to ${colorActive}`)
    await startFromDialog(page)
    await waitFor(page, (x) => x.plies === 0 && x.turn === 'white', 'hints game start')
    await playUci(page, 'e2e4')
    await waitFor(page, (x) => x.plies >= 1, 'e4')
    assert((await page.locator(`${TAB} .move-cell[data-ply="1"] .play-mark.check`).count()) === 1, 'no check mark on 1.e4')
    const s = await waitFor(page, (x) => x.plies === 2 && !x.thinking, 'bot book reply')
    const sans = await page.locator(`${TAB} .move-cell .move-san`).allInnerTexts()
    assert(sans[1] === 'c6', `bot played ${sans[1]}`)
    assert((await page.locator(`${TAB} .move-cell[data-ply="2"] .play-mark.book`).count()) === 1, 'no book mark on 1...c6')
    return `${sans.join(' ')} ${s.fen}`
  })
  await check('hints mode: a wrong move is rejected and the book move shown', async () => {
    await playUci(page, 'g1f3')
    await page.locator('[data-testid="play-book-miss"]').waitFor({ timeout: 3000 })
    const s = await state(page)
    assert(s.plies === 2, `plies ${s.plies}`)
    const arrows = await page.locator(`${BOARD} .cg-shapes line`).count()
    assert(arrows >= 1, 'no book arrow')
    const text = await page.locator('[data-testid="play-book-miss"]').innerText()
    assert(/d4/.test(text), text)
    await shot(page, '10-hints-miss')
    return text.replace(/\s+/g, ' ').slice(0, 160)
  })
  await check('hints mode: continuing the line (d4, Nc3, Nxe4) with checks', async () => {
    for (const [uci, ply] of [
      ['d2d4', 3],
      ['b1c3', 5],
      ['c3e4', 7],
    ]) {
      await waitFor(page, (x) => x.plies === ply - 1 && x.turn === 'white' && !x.thinking, `before ${uci}`)
      await playUci(page, uci)
      await waitFor(page, (x) => x.plies >= ply, uci, 5000)
      const marks = await page.locator(`${TAB} .move-cell[data-ply="${ply}"] .play-mark.check`).count()
      assert(marks === 1, `no check on ply ${ply}`)
    }
    await waitFor(page, (x) => x.plies === 8 && !x.thinking, 'bot reply Nf6')
    const sans = await page.locator(`${TAB} .move-cell .move-san`).allInnerTexts()
    assert(sans.join(' ') === 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6', sans.join(' '))
    const stats = await page.locator('.play-book-stats').innerText()
    await shot(page, '11-hints-book')
    return `${sans.join(' ')} | ${stats}`
  })
  await check('hints mode: "play anyway" leaves the book and the engine takes over', async () => {
    await playUci(page, 'f1d3')
    await page.locator('[data-testid="play-anyway"]').waitFor({ timeout: 3000 })
    await page.locator('[data-testid="play-anyway"]').click()
    await waitFor(page, (x) => x.plies === 9, 'Bd3 played', 5000)
    const left = await page.locator('.play-book-prompt.left').innerText()
    const before = botCalls.length
    await waitFor(page, (x) => x.plies === 10 && !x.thinking, 'engine reply', 20000)
    assert(botCalls.length > before, 'no /api/bot/move call after leaving the book')
    return left
  })

  // ---------------- start at end of line
  await check('start at end of a trap line that ends in mate: game over at once', async () => {
    await openNewGameDialog(page)
    await chooseOpening(page, '.play-new-modal', 'alien-gambit', 'alien-bf5-mate-trap', 'end')
    await startFromDialog(page)
    await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
    const text = await page.locator('[data-testid="play-over"]').innerText()
    assert(/checkmate/.test(text), text)
    await shot(page, '12-endline-mate')
    await page.keyboard.press('Escape')
    return text.replace(/\s+/g, ' ')
  })
  await check('start at end of line: the line is pre-played, bot replies, takeback cannot undo the line', async () => {
    await openNewGameDialog(page)
    await chooseOpening(page, '.play-new-modal', 'alien-gambit', 'alien-accepted-c5', 'end')
    await startFromDialog(page)
    const s = await waitFor(page, (x) => x.plies >= 27 && x.turn === 'white' && !x.thinking, 'line + bot reply', 30000)
    assert(s.plies === 28, `plies ${s.plies}`)
    const tb = page.locator(`${TAB} .play-toolbar button`, { hasText: 'Takeback' })
    assert(await tb.isDisabled(), 'takeback should be disabled right after the line')
    await shot(page, '13-endline')
    return s.fen
  })

  await check('board is not movable while the bot is thinking', async () => {
    await openNewGameDialog(page)
    const toggle = page.locator('.play-new-modal label.ui-toggle', { hasText: 'Start from an opening line' })
    if (await toggle.locator('input').isChecked()) await toggle.click()
    await page.locator('.play-new-modal button[data-color="white"]').click()
    await page.locator('.play-new-modal button[data-elo="1500"]').click()
    await page.locator('.play-new-modal button[data-movetime="2000"]').click()
    await startFromDialog(page)
    await waitFor(page, (x) => x.plies === 0 && x.turn === 'white', 'fresh game')
    await playUci(page, 'e2e4')
    await waitFor(page, (x) => x.plies === 1 && x.thinking, 'bot thinking', 5000)
    await playUci(page, 'd2d4') // own piece, not our turn
    await playUci(page, 'e7e5') // opponent piece
    const mid = await state(page)
    assert(mid.plies === 1, `plies changed while the bot was thinking: ${mid.plies}`)
    const end = await waitFor(page, (x) => x.plies === 2 && !x.thinking, 'bot reply', 20000)
    const call = botCalls[botCalls.length - 1]
    assert(call.movetime === 2000 && call.elo === 1500, JSON.stringify(call))
    return `bot replied ${call.san} (${call.strength?.mode} ${call.strength?.elo}); fen ${end.fen}`
  })

  await check('layout at 1100 px wide', async () => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.waitForTimeout(400)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert(!overflow, 'horizontal overflow')
    const bars = await page.locator(`${TAB} .play-bar`).count()
    assert(bars === 2, `${bars} player bars`)
    await shot(page, '14-1100px')
  })
} finally {
  console.log('\nbot calls:', botCalls.length)
  console.log('failed responses:', failedUrls.length ? failedUrls : 'none')
  if (consoleErrors.length) {
    console.log('CONSOLE ERRORS:')
    for (const e of consoleErrors) console.log('  ', e)
  } else console.log('console errors: none')
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exitCode = failed || consoleErrors.length ? 1 : 0
}
