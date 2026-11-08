// Playwright check of trying moves during a game review, against the real backend (Stockfish).
//
//   cd frontend && npm run build
//   cd backend  && python -m uvicorn app.main:app --port 8094
//   cd frontend && node src/tabs/Review/ReviewVariation.check.mjs [baseUrl]   (default http://localhost:8094)
//
// Screenshots go to frontend/screenshots/variation-*.png. Exit code 0 = all checks passed.
import { Chess } from 'chess.js'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8094'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
mkdirSync(SHOTS, { recursive: true })

// plies: 1 e4, 2 e5, 3 Qh5, 4 Nc6, 5 Bc4, 6 Nf6 (the blunder), 7 Qxf7#
const PGN = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n'
const SANS = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']

let failed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    const detail = await fn()
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${name}  (${err.message})`)
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message)
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage()
const errors = []
page.on('console', (m) => {
  // the deliberate network failure below logs itself; anything else counts
  if (m.type() === 'error' && !/favicon|ERR_FAILED/i.test(m.text())) errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const BOARD = '.review-board-wrap .board-root'
const fen = () => page.locator(BOARD).getAttribute('data-fen')
const shot = (name) => page.screenshot({ path: join(SHOTS, `variation-${name}.png`) })
const lineMoves = () => page.getByTestId('review-var-move')
const mainMove = (ply) => page.locator(`.review-movelist .move-cell[data-ply="${ply}"]`)
const verdictText = async () => (await page.getByTestId('review-verdict').textContent())?.trim() ?? ''
const fenAfter = (plies) => {
  const chess = new Chess()
  SANS.slice(0, plies).forEach((san) => chess.move(san))
  return chess.fen()
}

async function waitVerdict(pattern) {
  await page.waitForFunction(
    (source) => new RegExp(source).test(document.querySelector('[data-testid="review-verdict"]')?.textContent ?? ''),
    pattern.source,
    { timeout: 30000 },
  )
}

async function playOnBoard(uci) {
  const box = await page.locator(BOARD).boundingBox()
  const at = (s) => [box.x + ('abcdefgh'.indexOf(s[0]) + 0.5) * (box.width / 8), box.y + (8 - Number(s[1]) + 0.5) * (box.height / 8)]
  await page.mouse.click(...at(uci.slice(0, 2)))
  await page.mouse.click(...at(uci.slice(2, 4)))
}

try {
  let accuracy = ''
  await page.goto(BASE, { waitUntil: 'networkidle' })

  await check('a finished review opens on the Moves tab', async () => {
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: 'Import PGN' }).click()
    await page.getByTestId('review-pgn').fill(PGN)
    await page.getByTestId('review-depth-input').fill('10')
    await page.getByTestId('review-start').click()
    await page.locator('[data-testid="review-tab"][data-phase="done"]').waitFor({ timeout: 90000 })
    accuracy = await page.getByTestId('review-header').innerText()
    await page.getByTestId('review-tab-moves').click()
  })

  let best = ''
  await check('a bad move offers Play best move', async () => {
    await mainMove(6).click()
    await waitVerdict(/Nf6 is a (blunder|mistake)/)
    best = (await page.getByTestId('review-best-move').textContent())?.trim().replace(/^3\.\.\./, '') ?? ''
    assert(best, 'no best move shown')
    await page.getByTestId('review-play-best').waitFor({ timeout: 2000 })
    return `best is ${best}`
  })

  await check('Play best move plays it, says it is the best move, and adds a side line', async () => {
    await page.getByTestId('review-play-best').click()
    await waitVerdict(new RegExp(`3\\.\\.\\.${best.replace(/[+#]/g, '\\$&')} is the best move`))
    assert((await lineMoves().count()) === 1, `${await lineMoves().count()} moves in the line`)
    const expected = new Chess(fenAfter(5))
    expected.move(best)
    assert((await fen()) === expected.fen(), `board ${await fen()}`)
    assert((await page.locator('.review-movelist .move-cell.current').count()) === 0, 'a game move is still highlighted')
    assert(/top choice/.test(await page.getByTestId('review-details').innerText()), 'not called the top choice')
    assert((await page.getByTestId('review-play-best').count()) === 0, 'still offers Play best move')
    assert((await page.getByTestId('review-square-badge').getAttribute('data-classification')) === 'best', 'no best badge on the board')
    assert((await page.getByTestId('review-explain').count()) === 0, 'the coach panel still describes the game move')
    await shot('01-best-played')
    return await verdictText()
  })

  await check('more moves can be played on, and Stockfish grades each of them', async () => {
    await playOnBoard('a2a3')
    await page.getByTestId('review-tried-pending').waitFor({ timeout: 2000 }).catch(() => {})
    await waitVerdict(/4\.a3 is /)
    assert((await lineMoves().count()) === 2, `${await lineMoves().count()} moves in the line`)
    assert(/4\./.test(await page.getByTestId('review-variation').innerText()), 'no move number')
    await page.getByTestId('review-square-badge').waitFor({ timeout: 2000 })
    await shot('02-line-continues')
    return await verdictText()
  })

  await check('Left steps back through the line, then closes it at the game position', async () => {
    await page.keyboard.press('ArrowLeft')
    await waitVerdict(/is the best move/)
    assert((await lineMoves().count()) === 2, 'the line changed')
    await page.keyboard.press('ArrowLeft')
    await page.getByTestId('review-variation').waitFor({ state: 'detached', timeout: 2000 })
    assert((await fen()) === fenAfter(5), `board ${await fen()}`)
    assert((await page.getByTestId('review-explain').count()) === 1, 'the coach panel did not return')
  })

  await check('after 1.e4 you can play any legal Black move and Stockfish reviews it', async () => {
    await mainMove(1).click()
    await playOnBoard('c7c5')
    await waitVerdict(/1\.\.\.c5 is /)
    await shot('03-black-alternative')
    const order = await page.locator('.review-movelist').evaluate((el) => [...el.children].map((c) => c.className))
    assert(order[0] === 'move-row' && /review-variation/.test(order[1]), order.join(', '))
    return await verdictText()
  })

  await check('clicking another move makes the side line go away', async () => {
    await mainMove(4).click()
    await page.getByTestId('review-variation').waitFor({ state: 'detached', timeout: 2000 })
    assert((await fen()) === fenAfter(4), `board ${await fen()}`)
    assert((await mainMove(4).getAttribute('class')).includes('current'), 'move 4 is not highlighted')
  })

  await check('replacing a White move splits its row, with "..." like your example', async () => {
    await mainMove(2).click()
    await playOnBoard('g1f3')
    await waitVerdict(/2\.Nf3 is /)
    const order = await page.locator('.review-movelist').evaluate((el) => [...el.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()))
    assert(order[1].includes('Qh5') && order[1].includes('…'), order.join(' | '))
    assert(order[2].includes('Nf3'), order.join(' | '))
    assert(order[3].includes('…') && order[3].includes('Nc6'), order.join(' | '))
    await shot('04-row-split')
    return order.slice(1, 4).join(' | ')
  })

  await check('playing the move the game went on with just steps forward', async () => {
    await mainMove(2).click()
    await playOnBoard('d1h5')
    await page.waitForFunction(() => document.querySelector('.review-movelist .move-cell[data-ply="3"]')?.className.includes('current'), null, { timeout: 3000 })
    assert((await page.getByTestId('review-variation').count()) === 0, 'it opened a side line')
  })

  await check('Play best move on a bad tried move replaces it', async () => {
    await mainMove(2).click()
    await playOnBoard('a2a3')
    await waitVerdict(/2\.a3 is /)
    assert((await page.getByTestId('review-play-best').count()) === 1, 'no Play best move on 2.a3')
    await page.getByTestId('review-play-best').click()
    await waitVerdict(/is the best move/)
    assert((await lineMoves().count()) === 1, `${await lineMoves().count()} moves in the line`)
    assert(!(await lineMoves().first().innerText()).includes('a3'), 'a3 was not replaced')
  })

  await check('a failed check says so and Retry works', async () => {
    await mainMove(2).click()
    await page.route('**/api/coach/move', (route) => route.abort())
    await playOnBoard('h2h3')
    await page.getByTestId('review-tried-retry').waitFor({ timeout: 5000 })
    await page.unroute('**/api/coach/move')
    await page.getByTestId('review-tried-retry').click()
    await waitVerdict(/2\.h3 is /)
  })

  await check('trying moves leaves the report and the game alone', async () => {
    await mainMove(7).click()
    assert((await page.getByTestId('review-header').innerText()) === accuracy, 'the report changed')
    assert((await page.locator('.review-movelist .move-cell[data-ply]').count()) === SANS.length, 'the move list changed')
    assert((await fen()) === fenAfter(7), `board ${await fen()}`)
  })

  await check('no console errors', async () => {
    assert(errors.length === 0, errors.slice(0, 3).join(' | '))
  })
} finally {
  await browser.close()
  console.log(`\n${total - failed}/${total} checks passed; screenshots in ${SHOTS}`)
  process.exitCode = failed ? 1 : 0
}
