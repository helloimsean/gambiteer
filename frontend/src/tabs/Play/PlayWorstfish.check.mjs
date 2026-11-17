// Worstfish in the Play tab: the bot that always plays the worst move it can find (and has no Elo).
//   node src/tabs/Play/PlayWorstfish.check.mjs [base url] [screenshot folder]
//                                              (default http://localhost:8000, a fresh build)
// Needs the real Stockfish. Checks the card, that no Elo is shown anywhere, that its reply is one of the
// worst moves, a reload, History and a Chess960 game.
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

const state = () => page.locator(TAB).evaluate((el) => ({ bot: el.dataset.bot, plies: Number(el.dataset.plies), id: el.dataset.gameId }))
const savedGame = () => page.evaluate(() => JSON.parse(localStorage.getItem('play-game-v1')))

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
async function playAndWaitForReply(uci) {
  const before = (await state()).plies
  await drag(uci.slice(0, 2), uci.slice(2, 4))
  await page.waitForFunction(([sel, n]) => Number(document.querySelector(sel)?.dataset.plies) >= n, [TAB, before + 2], { timeout: 30_000 })
}

async function openPlay(setup) {
  await page.goto(BASE)
  await page.evaluate((s) => {
    localStorage.removeItem('play-game-v1')
    localStorage.removeItem('game-history-v1')
    localStorage.setItem('language-v1', 'en')
    localStorage.setItem('play-setup-v1', JSON.stringify({ mode: 'bot', bot: 'worstfish', color: 'white', variant: 'standard', movetimeMs: 300, ...s }))
  }, setup)
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
}

await openPlay({})

await check('the Worstfish card explains itself and the form has no Elo slider', async () => {
  const card = page.locator(`${TAB} .play-mode[data-bot="worstfish"]`)
  assert.match(await card.innerText(), /Worstfish[\s\S]*trying my hardest to lose[\s\S]*worst one I can find/)
  assert.equal(await card.getAttribute('aria-checked'), 'true')
  assert.match(await page.getByTestId('play-worstfish-note').innerText(), /no Elo[\s\S]*quiet move[\s\S]*check[\s\S]*capture/)
  assert.equal(await page.locator(`${TAB} .play-elo-slider`).count(), 0)
  if (SHOTS) await page.locator(TAB).screenshot({ path: path.join(SHOTS, 'worstfish-setup.png') })
})

await check('a game starts with no Elo shown for the bot', async () => {
  await page.locator(`${TAB} [data-testid="play-start"]`).click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.gameId, TAB)
  assert.equal((await state()).bot, 'worstfish')
  assert.equal(await page.getByTestId('play-elo-badge').count(), 0, 'an Elo badge is shown')
  const bars = await page.locator(`${TAB} [data-testid^="play-bar-"]`).allInnerTexts()
  assert(bars.some((b) => /Worstfish/.test(b)), bars.join(' | '))
  assert(!bars.some((b) => /3600/.test(b)), `a bar shows 3600: ${bars.join(' | ')}`)
  assert.match(await page.getByTestId('play-strength').innerText(), /Always plays the worst move it can find\./)
})

await check('after 1.e4 Worstfish plays one of the worst replies, never a sensible one', async () => {
  await playAndWaitForReply('e2e4')
  const g = await savedGame()
  // the five lowest at depth 10 are g5, b5, f5, f6 and Nh6, a few centipawns apart, so a short search may pick any
  assert(['g5', 'b5', 'f5', 'f6', 'Nh6'].includes(g.sans[1]), `Worstfish played ${g.sans[1]}`)
  if (SHOTS) await page.locator(TAB).screenshot({ path: path.join(SHOTS, 'worstfish-game.png') })
  return g.sans[1]
})

await check('the game survives a reload', async () => {
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
  const s = await state()
  assert.equal(s.bot, 'worstfish')
  assert.equal(s.plies, 2)
})

await check('History shows Worstfish without an Elo', async () => {
  await page.locator(`${TAB} .ui-toolbar button`, { hasText: 'Resign' }).first().click()
  await page.getByTestId('play-resign-confirm').click()
  await page.getByTestId('play-over').waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  const more = page.locator('.nav-item', { hasText: 'More' })
  if (await more.count()) await more.click()
  await page.locator('.nav-item', { hasText: 'History' }).click()
  const text = await page.getByTestId('history-row').first().innerText()
  assert.match(text, /Worstfish/)
  assert.doesNotMatch(text, /3600/)
  assert.equal(await page.locator('[data-testid="history-row"] .history-elo').count(), 0)
})

await check('it plays Chess960 too, and answers with a legal move', async () => {
  await openPlay({ variant: 'chess960' })
  await page.locator(`${TAB} [data-testid="play-start"]`).click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.gameId, TAB)
  await playAndWaitForReply('e2e4')
  assert.equal((await state()).plies, 2)
  assert.equal(await page.locator(`${TAB} .play-status.error`).count(), 0)
})

await check('no page errors', async () => {
  assert.deepEqual(problems, [])
})

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
