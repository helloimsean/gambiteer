// Playwright check of the History tab and of PGN import / export in Review and Analyze.
//
//   cd frontend && npm run build
//   cd backend  && LC0_PATH="<project>/backend/tests/fixtures/fake_lc0.py" python -m uvicorn app.main:app --port 8093
//   cd frontend && node src/tabs/History/History.check.mjs [baseUrl]   (default http://localhost:8093)
//
// Needs Stockfish. Maia runs on the stand-in engine, so this tests the app, not how Maia plays.
// Screenshots go to frontend/screenshots/history-*.png. Exit code 0 = all checks passed.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8093'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
mkdirSync(SHOTS, { recursive: true })

const PGN = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n'
const pgnPath = join(tmpdir(), `gambiteer-check-${process.pid}.pgn`)
const bigPath = join(tmpdir(), `gambiteer-check-big-${process.pid}.pgn`)
writeFileSync(pgnPath, PGN)
writeFileSync(bigPath, 'x'.repeat(2_000_001))

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
const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
const page = await context.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let reviewPosts = 0
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/review')) reviewPosts += 1
})

const shot = (name) => page.screenshot({ path: join(SHOTS, `history-${name}.png`) })
const tab = (name) => page.getByRole('button', { name, exact: true }).click()
const rows = () => page.getByTestId('history-row')
async function openHistory() {
  await tab('History')
  await page.getByTestId('history-tab').waitFor({ timeout: 5000 })
}

/** Plays 1.e4, waits for the bot's reply, then resigns and closes the result dialog. */
async function playAndResign(setup) {
  await page.evaluate((s) => {
    localStorage.setItem('play-setup-v1', JSON.stringify(s))
    localStorage.removeItem('play-game-v1')
  }, setup)
  await page.reload({ waitUntil: 'networkidle' })
  await tab('Play')
  await page.getByTestId('play-start').click()
  const board = page.locator('[data-testid="play-tab"] .board-root').first()
  await board.waitFor()
  const box = await board.boundingBox()
  const at = (s) => [box.x + ('abcdefgh'.indexOf(s[0]) + 0.5) * (box.width / 8), box.y + (8 - Number(s[1]) + 0.5) * (box.height / 8)]
  await page.mouse.click(...at('e2'))
  await page.mouse.click(...at('e4'))
  await page.waitForFunction(() => {
    const fen = document.querySelector('[data-testid="play-tab"] .board-root')?.getAttribute('data-fen') ?? ''
    return fen.split(' ')[1] === 'w' && fen.split(' ')[5] === '2'
  }, null, { timeout: 20000 })
  await page.getByRole('button', { name: 'Resign' }).first().click()
  await page.getByTestId('play-resign-confirm').click()
  await page.getByTestId('play-over').waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.getByTestId('play-over').waitFor({ state: 'hidden', timeout: 5000 })
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  await check('sidebar: More shows History, Less hides it, and the choice survives a reload', async () => {
    const more = page.getByTestId('nav-more')
    assert((await more.textContent())?.trim() === 'More', 'does not start on More')
    assert((await page.getByRole('button', { name: 'History', exact: true }).count()) === 0, 'History visible while collapsed')
    await more.click()
    assert((await more.textContent())?.trim() === 'Less', 'did not change to Less')
    await page.reload({ waitUntil: 'networkidle' })
    assert((await page.getByRole('button', { name: 'History', exact: true }).count()) === 1, 'not remembered after reload')
    await shot('01-sidebar-open')
    await page.getByTestId('nav-more').click()
    assert((await page.getByRole('button', { name: 'History', exact: true }).count()) === 0, 'Less did not hide it')
    await page.getByTestId('nav-more').click()
  })

  await check('empty history explains itself', async () => {
    await openHistory()
    assert(/No games yet/.test(await page.getByTestId('history-tab').innerText()), 'no empty state')
  })

  await check('finished games against Maia and Stockfish are saved, newest first', async () => {
    await playAndResign({ color: 'white', bot: 'maia', maiaElo: 1300, movetimeMs: 300 })
    await playAndResign({ color: 'white', bot: 'stockfish', elo: 1200, movetimeMs: 300 })
    await openHistory()
    assert((await rows().count()) === 2, `${await rows().count()} rows`)
    assert((await rows().nth(0).getAttribute('data-bot')) === 'stockfish', 'newest is not first')
    const maia = await rows().nth(1).innerText()
    assert(/Maia/.test(maia) && /\(1300\)/.test(maia) && /You/.test(maia), maia)
    assert(/Stockfish 19/.test(await rows().nth(0).innerText()) && /\(1200\)/.test(await rows().nth(0).innerText()), 'stockfish row')
    assert((await rows().nth(1).getByTestId('history-review').count()) === 1, 'no Review button')
    assert((await page.locator('.history-mark.loss').count()) === 2, 'resigned games are not marked as losses')
    assert(/Game History \(2\)/.test(await page.getByTestId('history-tab').innerText()), 'count in the title')
    await shot('02-unreviewed')
    return maia.replace(/\s+/g, ' ')
  })

  await check('a reload on a finished game does not add it twice', async () => {
    await tab('Play')
    await page.reload({ waitUntil: 'networkidle' })
    await tab('Play')
    await page.waitForTimeout(400)
    await openHistory()
    assert((await rows().count()) === 2, `${await rows().count()} rows`)
  })

  await check('Review on a history row waits on the setup card with that game', async () => {
    const before = reviewPosts
    await rows().nth(1).getByTestId('history-review').click()
    await page.getByTestId('review-lastgame').waitFor({ timeout: 5000 })
    await page.waitForTimeout(1200)
    assert(reviewPosts === before, 'a review started by itself')
    assert(/Maia \(1300\)/.test(await page.getByTestId('review-lastgame').innerText()), 'wrong game on the card')
    assert((await page.getByRole('button', { name: 'History game' }).count()) === 1, 'not labelled as a history game')
  })

  await check('after a review, the accuracy appears in History and only on that game', async () => {
    await page.getByTestId('review-depth-input').fill('8')
    await page.getByTestId('review-start').click()
    await page.locator('[data-testid="review-tab"][data-phase="done"]').waitFor({ timeout: 60000 })
    await shot('03-report')
    await openHistory()
    const numbers = await rows().nth(1).getByTestId('history-accuracy').innerText()
    assert(/\d+\.\d\s+\d+\.\d/.test(numbers), `accuracy "${numbers}"`)
    assert((await rows().nth(1).getByTestId('history-review').count()) === 0, 'Review button still there')
    assert((await rows().nth(0).getByTestId('history-review').count()) === 1, 'the other game changed too')
    await shot('04-reviewed')
    return numbers.replace(/\s+/g, ' / ')
  })

  await check('clicking the reviewed game reopens its report without a new review', async () => {
    const before = reviewPosts
    await rows().nth(1).click()
    await page.locator('[data-testid="review-tab"][data-phase="done"]').waitFor({ timeout: 5000 })
    assert(reviewPosts === before, 'it reviewed the game again')
  })

  await check('Review: Copy PGN and Download PGN give the game with its players and result', async () => {
    await page.getByTestId('pgn-copy').click()
    await page.getByTestId('pgn-copied').waitFor({ timeout: 3000 })
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    for (const part of ['[White "You"]', '[Black "Maia (1300)"]', '[Result "0-1"]', '1. e4', ' 0-1']) assert(copied.includes(part), `missing ${part} in:\n${copied}`)
    assert(/\[Date "\d{4}\.\d{2}\.\d{2}"\]/.test(copied), `no date in:\n${copied}`)
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pgn-download').click()])
    assert(/^You_vs_Maia_1300_\d{4}\.\d{2}\.\d{2}\.pgn$/.test(download.suggestedFilename()), download.suggestedFilename())
    // the Windows clipboard turns \n into \r\n
    assert(readFileSync(await download.path(), 'utf8') === copied.replace(/\r\n/g, '\n'), 'download differs from the copied text')
    return download.suggestedFilename()
  })

  await check('Review: opening a .pgn file fills in the game, and too large a file is refused', async () => {
    await page.getByTestId('review-new').click()
    await page.getByRole('button', { name: 'Import PGN' }).click()
    await page.getByTestId('pgn-file-input').setInputFiles(bigPath)
    await page.getByTestId('review-file-error').waitFor({ timeout: 3000 })
    await page.getByTestId('pgn-file-input').setInputFiles(pgnPath)
    await page.waitForFunction(() => document.querySelector('[data-testid="review-pgn"]')?.value.includes('Qxf7#'), null, { timeout: 3000 })
    assert((await page.getByTestId('review-file-error').count()) === 0, 'the old error stayed')
    assert(/\bactive\b/.test(await page.getByRole('button', { name: 'Import PGN' }).getAttribute('class')), 'Import PGN is not the selected source')
    await page.waitForTimeout(300) // let the button colours finish fading
    await shot('05-review-import')
    await page.getByTestId('review-start').click()
    await page.getByTestId('review-progress').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="review-tab"][data-phase="done"]').waitFor({ timeout: 90000 })
    assert(/Alice/.test(await page.getByTestId('review-header').innerText()), 'imported players missing')
    await page.getByTestId('pgn-copy').click()
    await page.getByTestId('pgn-copied').waitFor({ timeout: 3000 })
    assert((await page.evaluate(() => navigator.clipboard.readText())).includes('4. Qxf7#'), 'imported game not exported')
  })

  await check('the Analyze button on a history row loads that game', async () => {
    await openHistory()
    await rows().nth(1).getByTestId('history-analyze').click()
    await page.getByTestId('analyze-copy-pgn').waitFor({ timeout: 5000 })
    await page.getByTestId('analyze-tab-moves').click()
    assert((await page.locator('.analyze-movelist').innerText()).includes('e4'), 'moves not loaded')
    await shot('06-analyze')
  })

  await check('Analyze: Download gives a .pgn, and opening a .pgn file loads the game', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('analyze-download-pgn').click()])
    assert(/^analysis_\d{4}\.\d{2}\.\d{2}\.pgn$/.test(download.suggestedFilename()), download.suggestedFilename())
    assert(readFileSync(await download.path(), 'utf8').includes('1. e4'), 'no moves in the file')
    await page.getByTestId('analyze-tab-import').click()
    assert((await page.getByTestId('analyze-tab-import').textContent())?.trim() === 'Import PGN', 'tab label')
    await page.getByTestId('pgn-file-input').setInputFiles(pgnPath)
    await page.getByText('PGN loaded: 7 half-moves (Alice vs Bob).').waitFor({ timeout: 5000 })
    await shot('07-analyze-import')
    await page.getByTestId('analyze-tab-moves').click()
    assert((await page.locator('.analyze-movelist').innerText()).includes('Qxf7#'), 'file not loaded')
  })

  await check('History fits a phone-width window without sideways scrolling', async () => {
    await openHistory() // before narrowing: the sidebar has no text labels at this width
    await page.setViewportSize({ width: 390, height: 780 })
    await page.waitForTimeout(200)
    const fits = await page.locator('.history-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)
    await shot('08-phone')
    assert(fits, 'the table overflows')
    await page.setViewportSize({ width: 1366, height: 768 })
  })

  await check('no console errors', async () => {
    assert(errors.length === 0, errors.slice(0, 3).join(' | '))
  })
} finally {
  await browser.close()
  console.log(`\n${total - failed}/${total} checks passed; screenshots in ${SHOTS}`)
  process.exitCode = failed ? 1 : 0
}
