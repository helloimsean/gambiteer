// Playwright check of the Review tab against the real backend (Stockfish + Ollama).
//
//   backend on :8000 and `npm run dev` on :5173, then (cwd frontend/):
//   node src/tabs/Review/ReviewTab.e2e.mjs [baseUrl]
//
// Env: MODEL (default llama3.2:3b), DEPTH (default 10), HEADED=1 to watch.
// Screenshots go to frontend/screenshots/Review-*.png. Exit code 0 = all checks passed.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5173'
const MODEL = process.env.MODEL ?? 'llama3.2:3b'
const DEPTH = process.env.DEPTH ?? '10'

// Morphy's Opera Game: 33 plies, Black makes several mistakes, White finishes with sacrifices.
const OPERA = `[Event "Opera Game"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`

mkdirSync(SHOTS, { recursive: true })
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
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `Review-${name}.png`) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: !process.env.HEADED })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

const fenOf = () => page.locator('.review-board-wrap .board-root').getAttribute('data-fen')

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  await check('open Review tab', async () => {
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByTestId('review-setup').waitFor({ timeout: 5000 })
    await page.locator('.review-model-select select').first().waitFor({ timeout: 8000 })
    await shot(page, '01-setup')
  })

  await check('paste PGN and start review at depth ' + DEPTH, async () => {
    await page.getByRole('button', { name: 'Import PGN' }).click()
    await page.getByTestId('review-pgn').fill(OPERA)
    await page.getByTestId('review-depth-input').fill(DEPTH)
    await page.getByTestId('review-start').click()
  })

  await check('progress bar with ply count', async () => {
    const label = page.getByTestId('review-progress-label')
    await label.waitFor({ timeout: 5000 })
    let seen = ''
    for (let i = 0; i < 60; i++) {
      const t = (await label.textContent().catch(() => '')) ?? ''
      if (/Analysing ply \d+ of 33/.test(t)) {
        seen = t
        break
      }
      await sleep(50)
    }
    assert(seen, 'never saw "Analysing ply N of 33"')
    await shot(page, '02-progress')
    return seen
  })

  await check('review finishes: accuracy numbers', async () => {
    await page.locator('[data-phase="done"]').waitFor({ timeout: 120000 })
    const w = await page.getByTestId('review-accuracy-white').textContent()
    const b = await page.getByTestId('review-accuracy-black').textContent()
    assert(/^\d{1,3}\.\d$/.test(w ?? '') && /^\d{1,3}\.\d$/.test(b ?? ''), `accuracy text ${w} / ${b}`)
    await sleep(300)
    await shot(page, '03-summary')
    return `white ${w}, black ${b}`
  })

  await check('count table with badges for both sides', async () => {
    const rows = page.locator('[data-testid="review-counts"] tbody tr')
    assert((await rows.count()) === 10, 'expected 10 classification rows')
    const badges = await page.locator('[data-testid="review-counts"] .cls-badge svg').count()
    assert(badges === 10, `badges ${badges}`)
    const counts = await page.locator('[data-testid="review-counts"] .review-count').allTextContents()
    const total = counts.reduce((s, c) => s + Number(c), 0)
    assert(total === 33, `counts sum to ${total}, expected 33`)
    return counts.join(',')
  })

  await check('eval graph rendered with key-moment dots', async () => {
    const area = await page.locator('.review-graph-area').getAttribute('d')
    assert(area && area.split('L').length > 30, 'area path too short')
    const dots = await page.locator('.review-graph-dot').count()
    assert(dots > 0, 'no key moment dots')
    return `${dots} dots`
  })

  let mistakePly = 0
  await check('click a key moment -> board + details + arrows', async () => {
    const moments = page.locator('.review-moment')
    assert((await moments.count()) > 0, 'no key moments listed')
    // prefer a mistake/blunder so the best-move arrow is drawn
    const all = await moments.evaluateAll((els) => els.map((e) => ({ ply: Number(e.getAttribute('data-ply')), text: e.textContent ?? '' })))
    const pick = all.find((m) => /Mistake|Blunder/.test(m.text)) ?? all[0]
    mistakePly = pick.ply
    await page.locator(`.review-moment[data-ply="${pick.ply}"]`).click()
    await page.getByTestId('review-details').waitFor()
    const verdict = await page.getByTestId('review-verdict').textContent()
    assert(/ is (a|an|the|brilliant|excellent|good)/.test(verdict ?? ''), `verdict "${verdict}"`)
    const arrows = await page.locator('.review-overlay-svg line').count()
    const badge = await page.getByTestId('review-square-badge').count()
    assert(badge === 1, 'square badge missing')
    await sleep(300)
    await shot(page, '04-move-details')
    return `${verdict}; ${arrows} arrow(s); best: ${await page.getByTestId('review-best-move').textContent().catch(() => '-')}`
  })

  await check('move list badges + click a move', async () => {
    const cells = page.locator('.review-movelist .move-cell[data-ply]')
    assert((await cells.count()) === 33, 'expected 33 move cells')
    assert((await page.locator('.review-movelist .move-badge .cls-badge').count()) === 33, 'badges missing in move list')
    const before = await fenOf()
    await page.locator('.review-movelist .move-cell[data-ply="5"]').click()
    const after = await fenOf()
    assert(before !== after, 'board did not change')
    const cur = await page.locator('.review-movelist .move-cell.current').getAttribute('data-ply')
    assert(cur === '5', `current ply ${cur}`)
  })

  await check('keyboard left/right navigation', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    const f5 = await fenOf()
    await page.keyboard.press('ArrowRight')
    await sleep(80)
    const f6 = await fenOf()
    assert(f6 !== f5, 'ArrowRight did not move')
    assert((await page.locator('.review-movelist .move-cell.current').getAttribute('data-ply')) === '6', 'not at ply 6')
    await page.keyboard.press('ArrowLeft')
    await sleep(80)
    assert((await fenOf()) === f5, 'ArrowLeft did not go back')
  })

  await check('click on the eval graph jumps', async () => {
    const box = await page.getByTestId('review-graph').boundingBox()
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
    await sleep(100)
    const cur = Number(await page.locator('.review-movelist .move-cell.current').getAttribute('data-ply'))
    assert(cur >= 28, `graph click went to ply ${cur}`)
    return `ply ${cur}`
  })

  await check(`Explain streams text (${MODEL})`, async () => {
    await page.locator(`.review-movelist .move-cell[data-ply="${mistakePly}"]`).click()
    const select = page.locator('.review-explain .review-model-select select')
    await select.selectOption(MODEL)
    await page.getByTestId('review-explain-btn').click()
    const text = page.getByTestId('review-explain-text')
    await text.waitFor({ timeout: 60000 })
    // sample the length while streaming: it must grow over time
    const lengths = []
    for (let i = 0; i < 400; i++) {
      const len = ((await text.textContent()) ?? '').length
      if (lengths.length === 0 || len !== lengths[lengths.length - 1]) lengths.push(len)
      if ((await page.locator('.review-explain-text.streaming').count()) === 0 && len > 0) break
      await sleep(100)
    }
    const final = (await text.textContent()) ?? ''
    assert(final.trim().length > 40, `explanation too short: "${final}"`)
    assert(lengths.length >= 3, `text did not grow incrementally (${lengths.join(',')})`)
    await shot(page, '05-explain')
    return `${lengths.length} growth steps, ${final.length} chars: "${final.slice(0, 90)}..."`
  })

  await check('Explain all key moments + Stop', async () => {
    const btn = page.getByTestId('review-explain-all')
    const label = await btn.textContent()
    const total = Number(/\((\d+)\)/.exec(label ?? '')?.[1] ?? '0')
    assert(total >= 1, `no remaining key moments (${label})`)
    await btn.click()
    const status = page.getByTestId('review-batch-status')
    await status.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => /^\s*2 \//.test(document.querySelector('[data-testid="review-batch-status"]')?.textContent ?? ''), null, {
      timeout: 90000,
    }).catch(() => {})
    await sleep(600)
    await shot(page, '06-explain-all-running')
    const st = await status.textContent().catch(() => '')
    await page.getByTestId('review-explain-all-stop').click()
    await page.getByTestId('review-explain-all').waitFor({ timeout: 3000 })
    return `stopped at "${st?.trim()}" of ${total}`
  })

  await check('Explain all runs to the end', async () => {
    await page.getByTestId('review-explain-all').click()
    await page.getByTestId('review-batch-status').waitFor({ timeout: 5000 })
    await page.getByTestId('review-explain-all').waitFor({ timeout: 240000 })
    // every key moment now has an explanation: walk them
    const plies = await page.evaluate(() => {
      const raw = localStorage.getItem('review-state-v1')
      const s = raw ? JSON.parse(raw) : null
      const keys = ['blunder', 'mistake', 'miss', 'inaccuracy', 'brilliant', 'great']
      const key = s.result.moves.filter((m) => keys.includes(m.classification)).map((m) => m.ply)
      return { key, explained: Object.keys(s.explanations ?? {}).map(Number) }
    })
    const missing = plies.key.filter((p) => !plies.explained.includes(p))
    assert(missing.length === 0, `no explanation for plies ${missing.join(',')}`)
    await shot(page, '07-explain-all-done')
    return `${plies.key.length} key moments explained`
  })

  await check('review survives a tab switch', async () => {
    await page.getByRole('button', { name: 'Analyze', exact: true }).click()
    await sleep(400)
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.locator('[data-phase="done"]').waitFor({ timeout: 5000 })
    await page.getByTestId('review-tab-moves').click()
    await page.locator(`.review-movelist .move-cell[data-ply="${mistakePly}"]`).click()
    const t = await page.getByTestId('review-explain-text').textContent()
    assert((t ?? '').length > 40, 'explanation lost after tab switch')
  })

  await check('narrow window (1100 px) layout', async () => {
    await page.setViewportSize({ width: 1100, height: 760 })
    await sleep(400)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert(!overflow, 'horizontal overflow at 1100px')
    await shot(page, '08-narrow')
    await page.setViewportSize({ width: 1600, height: 1000 })
  })

  await check('friendly message when Ollama is unavailable', async () => {
    await page.route('**/api/ollama/models', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [], default: '' }) }),
    )
    await page.getByRole('button', { name: 'Analyze', exact: true }).click()
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByTestId('review-tab-moves').click()
    await page.getByTestId('review-ollama-down').first().waitFor({ timeout: 5000 })
    assert(await page.getByTestId('review-explain-btn').isDisabled(), 'Explain should be disabled')
    await shot(page, '09-ollama-down')
    await page.unroute('**/api/ollama/models')
  })

  await check('last game source', async () => {
    await page.evaluate(() => {
      localStorage.setItem(
        'last-game-v1',
        JSON.stringify({
          sans: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'],
          players: { white: 'You', black: 'Stockfish (800)' },
          result: '1-0',
          reason: 'checkmate',
          playedAt: Date.now() - 5 * 60_000,
        }),
      )
      localStorage.removeItem('review-state-v1')
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByTestId('review-lastgame').waitFor({ timeout: 5000 })
    await page.getByTestId('review-depth-input').fill(DEPTH)
    await page.getByTestId('review-start').click()
    await page.locator('[data-phase="done"]').waitFor({ timeout: 60000 })
    const name = await page.locator('.review-player-white .review-player-name').textContent()
    assert(name?.includes('You'), `white name ${name}`)
    await shot(page, '10-last-game')
  })
  await check('"Review this game" from Play waits for depth and the Game Review button', async () => {
    let reviewPosts = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/review')) reviewPosts += 1
    })
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.getByTestId('play-setup').waitFor({ timeout: 8000 })
    await page.locator('[data-testid="play-setup"] [data-color="white"]').click()
    await page.getByTestId('play-start').click()
    const board = page.locator('[data-testid="play-tab"] .board-root').first()
    await board.waitFor()
    const box = await board.boundingBox()
    const sq = (s) => ({ x: box.x + ('abcdefgh'.indexOf(s[0]) + 0.5) * (box.width / 8), y: box.y + (8 - Number(s[1]) + 0.5) * (box.height / 8) })
    await page.mouse.click(sq('e2').x, sq('e2').y)
    await page.mouse.click(sq('e4').x, sq('e4').y)
    await page.waitForFunction(
      () => {
        const fen = document.querySelector('[data-testid="play-tab"] .board-root')?.getAttribute('data-fen') ?? ''
        return fen.split(' ')[1] === 'w' && fen.split(' ')[5] === '2'
      },
      null,
      { timeout: 20000 },
    )
    await page.getByRole('button', { name: 'Resign' }).first().click()
    await page.getByTestId('play-resign-confirm').click()
    await page.getByTestId('play-over-review').click()
    await page.getByTestId('review-lastgame').waitFor({ timeout: 5000 })
    await sleep(1500) // long enough for a review to have started if anything still auto-starts it
    assert(reviewPosts === 0, `${reviewPosts} review(s) started without the button`)
    assert((await page.getByTestId('review-tab').getAttribute('data-phase')) === 'setup', 'not on the setup card')
    assert(await page.locator('.review-depths .btn').first().isEnabled(), 'depth buttons are disabled')
    const start = page.getByTestId('review-start')
    assert((await start.textContent())?.trim() === 'Game Review', `button says "${await start.textContent()}"`)
    await shot(page, '11-from-play-setup')
    await page.getByTestId('review-depth-input').fill(DEPTH)
    await start.click()
    await page.locator('[data-phase="done"]').waitFor({ timeout: 60000 })
    const white = await page.locator('.review-player-white .review-player-name').textContent()
    const plies = await page.locator('[data-testid="review-counts"] .review-count').allTextContents()
    const total = plies.reduce((a, c) => a + Number(c), 0)
    assert(white?.includes('You') && total === 2, `white "${white}", ${total} plies`)
    await shot(page, '12-from-play')
    return `${white} vs ${await page.locator('.review-player-black .review-player-name').textContent()}`
  })
} finally {
  const relevant = consoleErrors.filter((e) => !/favicon/i.test(e))
  record('no console errors', relevant.length === 0, relevant.slice(0, 5).join(' | '))
  await browser.close()
  console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}
