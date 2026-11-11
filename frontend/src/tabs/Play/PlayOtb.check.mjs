// Over the board in the Play tab: two people on one device, the board turning to the side to move.
//   node src/tabs/Play/PlayOtb.check.mjs [base url]     (default http://localhost:8000, a fresh build)
// Plays through names, turning, takeback, checkmate, History, rematch, resign, agreed draw, a
// variant without an engine, and checks that a bot game still gets its replies.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const FRONT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '')
const require = createRequire(FRONT + '/package.json')
const { chromium } = require('playwright')

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8000'
const TAB = '[data-testid="play-tab"]'
const FLIP_WAIT_MS = 800 // OTB_FLIP_DELAY_MS plus a margin

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

async function tabState() {
  return page.locator(TAB).evaluate((el) => ({
    id: el.dataset.gameId,
    bot: el.dataset.bot,
    orientation: el.dataset.orientation,
    turn: el.dataset.turn,
    over: el.dataset.over === 'true',
    plies: Number(el.dataset.plies),
  }))
}
const status = () => page.locator('[data-testid="play-status"]').innerText()

async function drag(from, to) {
  const box = await page.locator(`${TAB} cg-board`).boundingBox()
  const { orientation } = await tabState()
  const at = (sq) => {
    const file = sq.charCodeAt(0) - 97
    const rank = Number(sq[1]) - 1
    const s = box.width / 8
    const col = orientation === 'white' ? file : 7 - file
    const row = orientation === 'white' ? 7 - rank : rank
    return { x: box.x + s * (col + 0.5), y: box.y + s * (row + 0.5) }
  }
  const a = at(from)
  const b = at(to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}
/** Play UCI moves one after another, waiting for the board to turn after each. */
async function play(...ucis) {
  for (const uci of ucis) {
    const before = (await tabState()).plies
    await drag(uci.slice(0, 2), uci.slice(2, 4))
    assert.equal((await tabState()).plies, before + 1, `${uci} was not played`)
    await page.waitForTimeout(FLIP_WAIT_MS)
  }
}
const button = (name) => page.locator(`${TAB} .ui-toolbar button`, { hasText: name }).first()
async function closeOverModal() {
  await page.locator('[data-testid="play-over"]').waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}
/** New game from the dialog (a game is on the board) or the side panel (none yet). */
async function startOtb({ white = '', black = '', autoFlip = true, variant = 'standard' } = {}) {
  const inDialog = (await tabState()).id !== ''
  if (inDialog) await button('New game').click()
  const scope = inDialog ? page.locator('.play-new-modal') : page.locator(TAB)
  await scope.locator('[data-bot="otb"]').click()
  await scope.locator('.play-variant-select select').selectOption(variant)
  await scope.locator('[data-testid="play-otb-name-white"]').fill(white)
  await scope.locator('[data-testid="play-otb-name-black"]').fill(black)
  const toggle = scope.locator('[data-testid="play-otb"] .ui-toggle')
  if ((await toggle.locator('input').isChecked()) !== autoFlip) await toggle.click()
  await scope.locator('[data-testid="play-start"]').click()
  await page.waitForTimeout(300)
}

await page.goto(BASE)
await page.evaluate(() => {
  localStorage.removeItem('play-game-v1')
  localStorage.removeItem('play-setup-v1')
  localStorage.removeItem('game-history-v1')
  localStorage.setItem('language-v1', 'en')
})
await page.reload()
await page.locator('.nav-item', { hasText: 'Play' }).click()
await page.locator(TAB).waitFor()

await check('the Over the board card shows names and hides the bot settings', async () => {
  await page.locator(`${TAB} [data-bot="otb"]`).click()
  await page.locator('[data-testid="play-otb"]').waitFor()
  assert.equal(await page.locator(`${TAB} .play-color-group`).count(), 0, '"I play as" still shown')
  assert.equal(await page.locator(`${TAB} .play-elo-slider`).count(), 0, 'the Elo slider still shown')
  assert.match(await page.locator(`${TAB} .panel-title`).first().innerText(), /Over the board/)
})

await check('a game starts with White at the bottom and both sides can move', async () => {
  await startOtb({ white: 'Alice', black: 'Bob' })
  const s = await tabState()
  assert.equal(s.bot, 'otb')
  assert.equal(s.orientation, 'white')
  assert.match(await status(), /Alice to move/)
  await play('e2e4')
  assert.equal((await tabState()).orientation, 'black', 'the board did not turn to Black')
  assert.match(await status(), /Bob to move/)
  await play('e7e5')
  assert.equal((await tabState()).orientation, 'white', 'the board did not turn back to White')
  return 'e4 e5, turned twice'
})

await check('takeback undoes one move and turns the board back', async () => {
  await button('Takeback').click()
  await page.waitForTimeout(FLIP_WAIT_MS)
  const s = await tabState()
  assert.equal(s.plies, 1)
  assert.equal(s.orientation, 'black')
  await play('e7e5')
})

await check('checkmate ends the game, names the winner and goes to History', async () => {
  await play('f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7')
  const s = await tabState()
  assert.ok(s.over, 'the game is not over')
  const over = await page.locator('[data-testid="play-over"]').innerText({ timeout: 5000 })
  assert.match(over, /Alice wins!/)
  assert.match(over, /Alice vs Bob/)
  await closeOverModal()
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('game-history-v1') ?? '[]'))
  assert.equal(history[0]?.otb, true)
  assert.deepEqual(history[0]?.players, { white: 'Alice', black: 'Bob' })
  assert.equal(history[0]?.result, '1-0')
  return `${s.plies} plies, 1-0`
})

await check('the History tab lists it with both names', async () => {
  const more = page.locator('.nav-item', { hasText: 'More' })
  if (await more.count()) await more.click()
  await page.locator('.nav-item', { hasText: 'History' }).click()
  const row = page.locator('[data-testid="history-row"]').first()
  await row.waitFor()
  assert.equal(await row.getAttribute('data-bot'), 'otb')
  const text = await row.innerText()
  assert.match(text, /Over the board/)
  assert.match(text, /Alice[\s\S]*Bob/)
  await page.locator('.nav-item', { hasText: 'Play' }).click()
  await page.locator(TAB).waitFor()
})

await check('rematch swaps the players', async () => {
  await page.locator(`${TAB} .play-over-actions button`, { hasText: 'Rematch' }).click()
  await page.waitForTimeout(300)
  const s = await tabState()
  assert.equal(s.plies, 0)
  assert.equal(s.orientation, 'white')
  assert.match(await status(), /Bob to move/)
})

await check('resign asks who resigns', async () => {
  await play('d2d4')
  await button('Resign').click()
  await page.locator('[data-testid="play-resign-black"]').click() // Alice, who has Black now
  const s = await tabState()
  assert.ok(s.over)
  assert.match(await page.locator('[data-testid="play-over"]').innerText({ timeout: 5000 }), /Bob wins!/)
  await closeOverModal()
  assert.match(await status(), /Bob won by resignation/)
})

await check('an agreed draw', async () => {
  await startOtb()
  await play('e2e4')
  await button('Draw').click()
  await page.locator('[data-testid="play-draw-confirm"]').click()
  assert.ok((await tabState()).over)
  await closeOverModal()
  assert.match(await status(), /Draw by agreement/)
  assert.match(await status(), /1\/2-1\/2/)
})

await check('with turning off the board stays on White', async () => {
  await startOtb({ autoFlip: false })
  await play('e2e4', 'e7e5')
  await page.waitForTimeout(FLIP_WAIT_MS)
  assert.equal((await tabState()).orientation, 'white')
})

await check('a variant needs no engine over the board', async () => {
  await startOtb({ variant: 'kingofthehill' })
  await play('e2e4', 'a7a6', 'e1e2', 'a6a5', 'e2e3', 'a5a4', 'e3d4')
  const s = await tabState()
  assert.ok(s.over, 'the king reached the centre but the game goes on')
  await closeOverModal()
  assert.match(await status(), /White won by reaching the center/)
})

await check('a bot game still gets its reply and keeps its side', async () => {
  await button('New game').click()
  await page.locator('.play-new-modal [data-bot="stockfish"]').click()
  await page.locator('.play-new-modal .play-variant-select select').selectOption('standard')
  await page.locator('.play-new-modal [data-color="white"]').click()
  await page.locator('.play-new-modal [data-testid="play-start"]').click()
  await page.waitForTimeout(300)
  await drag('e2', 'e4')
  await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.getAttribute('data-plies') === '2', null, { timeout: 30000 })
  const s = await tabState()
  assert.notEqual(s.bot, 'otb')
  assert.equal(s.orientation, 'white')
})

await check('no console errors', async () => {
  assert.equal(problems.length, 0, problems.slice(0, 5).join('\n'))
})

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
