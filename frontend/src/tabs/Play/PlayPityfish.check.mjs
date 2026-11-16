// PityFish in the Play tab: it loses 300 Elo each time you play the worst move available.
//   node src/tabs/Play/PlayPityfish.check.mjs [base url] [screenshot folder]
//                                             (default http://localhost:8000, a fresh build)
// Needs the real Stockfish. Plays g4 (the worst opening move), then checks the Elo, the move-list badge,
// a reload, a takeback (which gives the Elo back), a normal move, a Chess960 game and the setup card.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '')
const require = createRequire(FRONT + '/package.json')
const { chromium } = require('playwright')

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8000'
const SHOTS = process.argv[3] ?? null
const TAB = '[data-testid="play-tab"]'

const results = []
async function check(name, fn) {
  const started = performance.now()
  try {
    const detail = await fn()
    results.push(true)
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}  ${((performance.now() - started) / 1000).toFixed(1)} s`)
  } catch (error) {
    results.push(false)
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
const worstCalls = []
page.on('request', (r) => r.url().endsWith('/api/bot/worst') && worstCalls.push(JSON.parse(r.postData() ?? '{}')))

const state = () =>
  page.locator(TAB).evaluate((el) => ({ bot: el.dataset.bot, elo: Number(el.dataset.botElo), plies: Number(el.dataset.plies), over: el.dataset.over === 'true', id: el.dataset.gameId }))

async function drag(from, to) {
  const box = await page.locator(`${TAB} cg-board`).boundingBox()
  const white = (await page.locator(TAB).getAttribute('data-orientation')) === 'white'
  const at = (sq) => {
    const file = sq.charCodeAt(0) - 97
    const rank = Number(sq[1]) - 1
    const s = box.width / 8
    return { x: box.x + s * ((white ? file : 7 - file) + 0.5), y: box.y + s * ((white ? 7 - rank : rank) + 0.5) }
  }
  const a = at(from)
  const b = at(to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
}
/** Play a move and wait for the bot's reply (two more plies). */
async function playAndWaitForReply(uci) {
  const before = (await state()).plies
  await drag(uci.slice(0, 2), uci.slice(2, 4))
  await page.waitForFunction(
    ([sel, n]) => Number(document.querySelector(sel)?.dataset.plies) >= n,
    [TAB, before + 2],
    { timeout: 30_000 },
  )
}
const button = (name) => page.locator(`${TAB} .ui-toolbar button`, { hasText: name }).first()

async function openPlay(setup) {
  await page.goto(BASE)
  await page.evaluate((s) => {
    localStorage.removeItem('play-game-v1')
    localStorage.removeItem('game-history-v1')
    localStorage.setItem('language-v1', 'en')
    localStorage.setItem('play-setup-v1', JSON.stringify({ mode: 'bot', bot: 'pityfish', color: 'white', variant: 'standard', movetimeMs: 300, ...s }))
  }, setup)
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
}

await openPlay({})

await check('the PityFish card explains the rule and starts at full strength', async () => {
  const card = page.locator(`${TAB} .play-mode[data-bot="pityfish"]`)
  assert.match(await card.innerText(), /PityFish[\s\S]*worst move[\s\S]*300 Elo/)
  assert.equal(await card.getAttribute('aria-checked'), 'true')
  const note = await page.getByTestId('play-pityfish-note').innerText()
  assert.match(note, /3600[\s\S]*worst one available[\s\S]*300 Elo[\s\S]*12 of them/)
  assert.equal(await page.locator(`${TAB} .play-elo-slider`).count(), 0, 'the Elo slider is shown')
  if (SHOTS) await page.locator(TAB).screenshot({ path: path.join(SHOTS, 'pityfish-setup.png') })
})

await check('a game starts against PityFish at 3600', async () => {
  await page.locator(`${TAB} [data-testid="play-start"]`).click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.gameId, TAB)
  const s = await state()
  assert.equal(s.bot, 'pityfish')
  assert.equal(s.elo, 3600)
  assert.match(await page.getByTestId('play-elo-badge').getAttribute('title'), /Full strength\. Every time you play the worst move it loses 300 Elo/)
})

await check('a sensible first move costs nothing', async () => {
  await playAndWaitForReply('e2e4')
  assert.equal((await state()).elo, 3600)
  assert.equal(worstCalls.length, 1)
  assert.equal(worstCalls[0].move, 'e4')
  assert.equal(await page.locator(`${TAB} .play-mark`).count(), 0)
  await button('Takeback').click()
  await page.waitForFunction((sel) => Number(document.querySelector(sel)?.dataset.plies) === 0, TAB)
})

await check('playing the worst move (g4) costs it 300 Elo, with a badge on the move', async () => {
  await playAndWaitForReply('g2g4')
  const s = await state()
  assert.equal(s.elo, 3300)
  assert.equal(await page.getByTestId('play-elo-badge').innerText(), '3300')
  const badge = page.locator(`${TAB} .play-mark`)
  assert.equal(await badge.count(), 1)
  assert.match(await badge.locator('svg').getAttribute('aria-label'), /Worst move! PityFish loses 300 Elo\./)
  if (SHOTS) await page.locator(TAB).screenshot({ path: path.join(SHOTS, 'pityfish-after-worst.png') })
  return `elo ${s.elo}`
})

await check('the Elo survives a reload', async () => {
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
  const s = await state()
  assert.equal(s.elo, 3300)
  assert.equal(s.plies, 2)
  assert.equal(await page.locator(`${TAB} .play-mark`).count(), 1)
})

await check('a takeback gives the Elo back, and a good move then costs nothing', async () => {
  await button('Takeback').click()
  await page.waitForFunction((sel) => Number(document.querySelector(sel)?.dataset.plies) === 0, TAB)
  assert.equal((await state()).elo, 3600)
  assert.equal(await page.locator(`${TAB} .play-mark`).count(), 0)
  await playAndWaitForReply('d2d4')
  assert.equal((await state()).elo, 3600)
})

await check('the Elo is kept in the saved game after the bot has replied again', async () => {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('play-game-v1')))
  assert.equal(saved.bot, 'pityfish')
  assert.deepEqual(saved.worst, [])
})

await check('it also rates moves in a variant on Stockfish (Chess960) without an error', async () => {
  await openPlay({ variant: 'chess960' })
  await page.locator(`${TAB} [data-testid="play-start"]`).click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.gameId, TAB)
  await playAndWaitForReply('e2e4')
  const s = await state()
  assert.equal(s.plies, 2)
  assert([3600, 3300].includes(s.elo), `elo ${s.elo}`)
  assert.equal(await page.locator(`${TAB} .play-status.error`).count(), 0)
  return `elo ${s.elo}`
})

await check('no page errors', async () => {
  assert.deepEqual(problems, [])
})

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
