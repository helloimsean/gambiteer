// Game Review's advanced Stockfish settings: the section that folds open on the setup card.
//   node src/tabs/Review/ReviewEngineSettings.check.mjs [base url] [screenshot folder]
//                                                      (default http://localhost:8000, a fresh build)
// Opens it, changes threads, hash and the time limit, checks that a review sends them and finishes,
// that they and the open state survive a reload, and that Reset puts the backend's own back.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '')
const require = createRequire(FRONT + '/package.json')
const { chromium } = require('playwright')

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8000'
const SHOTS = process.argv[3] ?? null
const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *'

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
const reviewBodies = []
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/review')) reviewBodies.push(JSON.parse(r.postData() ?? '{}'))
})

const health = await (await fetch(`${BASE}/api/health`)).json()
const info = health.reviewEngine
assert(info, 'the backend does not report reviewEngine (restart it)')

await page.goto(BASE)
await page.evaluate(() => {
  localStorage.removeItem('review-state-v1')
  localStorage.removeItem('review-advanced-open-v1')
  localStorage.setItem('settings-v1', JSON.stringify({ sound: false, coordinates: true, ollamaModel: '', defaultDepth: 16 }))
  localStorage.setItem('language-v1', 'en')
})
await page.reload()
await page.locator('.nav-item', { hasText: 'Review' }).click()

const section = page.getByTestId('review-advanced')
const toggle = page.getByTestId('review-advanced-toggle')
const body = page.getByTestId('review-advanced-body')
const slider = (name) => page.locator(`.review-advanced-${name} input[type="range"]`)
const value = (name) => page.locator(`.review-advanced-${name} .ui-value`).innerText()
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('settings-v1') ?? '{}').reviewEngine ?? null)

await check('sits between engine depth and explanation model, closed, with a summary', async () => {
  const labels = await page.locator('[data-testid="review-setup"] .review-field-label').allInnerTexts()
  const at = labels.indexOf('ADVANCED STOCKFISH SETTINGS')
  assert(at > 0, `labels: ${labels.join(' | ')}`)
  assert.equal(labels[at - 1], 'ENGINE DEPTH')
  assert.equal(labels[at + 1], 'EXPLANATION MODEL')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await body.count(), 0)
  const summary = await page.getByTestId('review-advanced-summary').innerText()
  assert.match(summary, new RegExp(`^${info.threads} threads? · `))
  return summary
})

await check('opens in place on the card background, not in a box of its own', async () => {
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  await body.waitFor()
  const look = await section.evaluate((el) => {
    const s = getComputedStyle(el)
    const b = getComputedStyle(el.querySelector('.review-advanced-body'))
    return { bg: s.backgroundColor, bodyBg: b.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, position: b.position }
  })
  assert.equal(look.bg, 'rgba(0, 0, 0, 0)')
  assert.equal(look.bodyBg, 'rgba(0, 0, 0, 0)')
  assert.equal(look.border, '0px')
  assert.equal(look.shadow, 'none')
  assert.equal(look.position, 'static')
  assert.equal(await value('threads'), `${info.threads} threads`)
  assert.equal(await value('time'), 'No limit')
  assert.equal(await page.getByTestId('review-advanced-reset').count(), 0)
  if (SHOTS) await page.getByTestId('review-setup').screenshot({ path: path.join(SHOTS, 'review-advanced-open.png') })
  return `${await value('threads')}, ${await value('hash')}, ${await value('time')}`
})

await check('changing the settings stores them and offers Reset', async () => {
  await slider('threads').fill('1')
  await slider('hash').fill('1') // 32 MB
  await slider('time').fill('1') // 0.5 s
  assert.equal(await value('threads'), '1 thread')
  assert.equal(await value('hash'), '32 MB')
  assert.equal(await value('time'), '0.5 s')
  assert.deepEqual(await stored(), { threads: 1, hashMb: 32, moveTimeMs: 500 })
  await page.getByTestId('review-advanced-reset').waitFor()
})

await check('a review sends them and finishes', async () => {
  await page.locator('.review-source .btn', { hasText: 'Import PGN' }).click()
  await page.getByTestId('review-pgn').fill(PGN)
  await page.getByTestId('review-start').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="review-tab"]')?.dataset.phase === 'done', null, { timeout: 60_000 })
  const sent = reviewBodies.at(-1)
  assert.equal(sent.threads, 1)
  assert.equal(sent.hashMb, 32)
  assert.equal(sent.moveTimeMs, 500)
  return JSON.stringify({ threads: sent.threads, hashMb: sent.hashMb, moveTimeMs: sent.moveTimeMs })
})

await check('the settings and the open state survive a reload', async () => {
  await page.evaluate(() => localStorage.removeItem('review-state-v1'))
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Review' }).click()
  await body.waitFor()
  assert.equal(await value('threads'), '1 thread')
  assert.equal(await value('hash'), '32 MB')
  assert.equal(await value('time'), '0.5 s')
})

await check("Reset puts the backend's own back, and a review then leaves them out", async () => {
  await page.getByTestId('review-advanced-reset').click()
  assert.deepEqual(await stored(), { threads: null, hashMb: null, moveTimeMs: null })
  assert.equal(await value('threads'), `${info.threads} threads`)
  assert.equal(await value('time'), 'No limit')
  assert.equal(await page.getByTestId('review-advanced-reset').count(), 0)
  await page.locator('.review-source .btn', { hasText: 'Import PGN' }).click()
  await page.getByTestId('review-pgn').fill(PGN)
  await page.getByTestId('review-start').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="review-tab"]')?.dataset.phase === 'done', null, { timeout: 120_000 })
  const sent = reviewBodies.at(-1)
  assert(!('threads' in sent) && !('hashMb' in sent) && !('moveTimeMs' in sent), JSON.stringify(sent))
})

await check('folding it closed again keeps the summary', async () => {
  await page.evaluate(() => localStorage.removeItem('review-state-v1'))
  await page.reload()
  await page.locator('.nav-item', { hasText: 'Review' }).click()
  await toggle.click()
  assert.equal(await body.count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('review-advanced-open-v1')), 'false')
  return await page.getByTestId('review-advanced-summary').innerText()
})

await check('no page errors', async () => {
  assert.deepEqual(problems, [])
})

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
