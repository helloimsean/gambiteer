// Playwright check of the Analyze tab against the real backend (not bundled; run with node).
//
//   backend on :8000, `npm run dev` (or `npx vite --port 5181`) running, then from frontend/:
//   node src/tabs/Analyze/AnalyzeTab.check.mjs [baseUrl]        (default http://localhost:5173)
//
// Screenshots go to frontend/screenshots/Analyze-*.png. Exit code 0 = all checks passed.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5173'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
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
    record(name, false, err instanceof Error ? err.message : String(err))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const ROOT = '[data-testid="analyze-board"] .board-root'
const ENGINE = '[data-testid="analyze-engine"]'

async function fenOf(page) {
  return page.locator(ROOT).getAttribute('data-fen')
}
async function boardBox(page) {
  const box = await page.locator(`${ROOT} cg-board`).boundingBox()
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
  const o = (await page.locator(ROOT).getAttribute('data-orientation')) ?? 'white'
  const a = center(box, from, o)
  const b = center(box, to, o)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}
async function playUci(page, ucis) {
  for (const u of ucis) {
    const before = await fenOf(page)
    await drag(page, u.slice(0, 2), u.slice(2, 4))
    await page.waitForFunction(
      ([sel, prev]) => document.querySelector(sel)?.getAttribute('data-fen') !== prev,
      [ROOT, before],
      { timeout: 3000 },
    )
  }
  await page.waitForTimeout(250)
}
async function waitForLines(page, n, timeout = 20000) {
  await page.waitForFunction(
    ([sel, want]) => document.querySelectorAll(`${sel} .engine-line`).length === want,
    [ENGINE, n],
    { timeout },
  )
}
async function engineHead(page) {
  return page
    .locator(`${ENGINE} .engine-head .mono`)
    .allTextContents()
    .catch(() => [])
}
async function engineDepth(page) {
  const parts = await engineHead(page)
  const m = /depth (\d+)/.exec(parts.find((t) => t.startsWith('depth')) ?? '')
  return m ? Number(m[1]) : 0
}
async function evalBar(page) {
  return page.locator('[data-testid="analyze-board"] .eval-bar').evaluate((el) => ({
    label: el.getAttribute('data-score') ?? '',
    white: el.querySelector('.eval-bar-white')?.style.height ?? '',
  }))
}
/** Arrows chessground currently draws (engine auto-shapes + user shapes). */
async function arrowCount(page) {
  return page.locator(`${ROOT} svg.cg-shapes line`).count()
}
async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `Analyze-${name}.png`) })
}
async function sideTab(page, id) {
  await page.locator(`[data-testid="analyze-tab-${id}"]`).click()
  await page.waitForTimeout(100)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

const wsFrames = []
let analyzeWsClosed = 0
page.on('websocket', (ws) => {
  if (!ws.url().includes('/ws/analyze')) return
  ws.on('framesent', (f) => wsFrames.push(String(f.payload)))
  ws.on('close', () => {
    analyzeWsClosed += 1
  })
})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('.nav-item', { hasText: 'Analyze' }).click()
  await page.locator('[data-testid="analyze-tab"]').waitFor()
  await page.locator(`${ROOT} cg-board piece`).first().waitFor()

  await check('engine streams lines for the start position and the depth grows', async () => {
    await waitForLines(page, 3)
    const d1 = await engineDepth(page)
    await page.waitForTimeout(1500)
    const d2 = await engineDepth(page)
    assert(d2 >= d1 && d2 > 0, `depth ${d1} -> ${d2}`)
    const bar = await evalBar(page)
    assert(/^[+-]?\d|M/.test(bar.label), `eval bar label "${bar.label}"`)
    return `depth ${d1} -> ${d2} (${(await engineHead(page)).join(', ')}), eval ${bar.label}, white share ${bar.white}`
  })

  await check('best and second-best arrows are drawn', async () => {
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} svg.cg-shapes line`).length >= 2, ROOT, { timeout: 5000 })
    return `${await arrowCount(page)} arrows`
  })
  await shot(page, '01-start-engine')

  await check('making a move updates the board, the move list and the analysis', async () => {
    const before = await evalBar(page)
    await playUci(page, ['e2e4'])
    const fen = await fenOf(page)
    assert(fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b'), `fen ${fen}`)
    assert((await page.locator('.analyze-movelist .move-cell[data-ply]').count()) === 1, 'move list')
    // the lines must now be black moves: first PV move numbered "1…"
    await page.waitForFunction(
      (sel) => {
        const first = document.querySelector(`${sel} .engine-line .pv-num`)
        return first && first.textContent.includes('…')
      },
      ENGINE,
      { timeout: 15000 },
    )
    const after = await evalBar(page)
    return `eval ${before.label} (${before.white}) -> ${after.label} (${after.white})`
  })

  await check('eval bar moves when the evaluation changes (1.e4 f6 2.d4 g5?? allows Qh5#)', async () => {
    const before = await evalBar(page)
    await playUci(page, ['f7f6', 'd2d4', 'g7g5'])
    await page.waitForFunction(
      (sel) => /M1/.test(document.querySelector(`${sel} .engine-score`)?.textContent ?? ''),
      ENGINE,
      { timeout: 15000 },
    )
    await page.waitForTimeout(2500)
    const after = await evalBar(page)
    assert(after.white !== before.white, `white share stayed ${after.white}`)
    await shot(page, '02-eval-bar-moves')
    // back out of that line
    await page.locator('.analyze-movelist .move-cell[data-ply="1"]').click()
    await page.locator('button[title^="Undo to here"]').click()
    await page.waitForTimeout(200)
    const n = await page.locator('.analyze-movelist .move-cell[data-ply]').count()
    assert(n === 1, `undo to here left ${n} moves`)
    return `white share ${before.white} -> ${after.white} (label ${after.label})`
  })

  await check('opening label appears for the Alien Gambit (1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Nf6 5.Ng5)', async () => {
    await playUci(page, ['c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'g8f6', 'e4g5'])
    const card = page.locator('[data-testid="analyze-opening"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="analyze-opening"]')?.getAttribute('data-status') === 'book', null, { timeout: 10000 })
    const id = await card.getAttribute('data-opening')
    const name = await page.locator('[data-testid="analyze-opening-name"]').textContent()
    const why = await page.locator('[data-testid="analyze-opening-why"]').textContent()
    assert(id === 'alien-gambit', `opening ${id} (${name})`)
    assert(why && why.length > 20, `why "${why}"`)
    await page.waitForTimeout(1200)
    await shot(page, '03-opening-alien-gambit')
    return `${name}: ${why.slice(0, 90)}…`
  })

  await check('opening label at an earlier ply shows the why of that move (jump to 2.d4)', async () => {
    await page.locator('.analyze-movelist .move-cell[data-ply="3"]').click()
    await page.waitForTimeout(200)
    const status = await page.locator('[data-testid="analyze-opening"]').getAttribute('data-status')
    const why = await page.locator('[data-testid="analyze-opening-why"]').textContent()
    assert(status === 'book' && why.startsWith('2.d4'), `status ${status}, why "${why}"`)
    await page.keyboard.press('End')
    await page.waitForTimeout(200)
    const cur = await page.locator('.analyze-movelist .move-cell.current').getAttribute('data-ply')
    assert(cur === '9', `End key: current ply ${cur}`)
    return why.slice(0, 80)
  })

  await check('MultiPV 5 shows five lines, MultiPV 1 one line and one arrow', async () => {
    await page.locator(`${ENGINE} .analyze-multipv select`).selectOption('5')
    await waitForLines(page, 5)
    await page.waitForTimeout(500)
    const arrows5 = await arrowCount(page)
    await shot(page, '04-multipv-5')
    await page.locator(`${ENGINE} .analyze-multipv select`).selectOption('1')
    await waitForLines(page, 1)
    await page.waitForTimeout(400)
    const arrows1 = await arrowCount(page)
    assert(arrows1 === 1, `${arrows1} arrows with MultiPV 1`)
    assert(arrows5 === 2, `${arrows5} arrows with MultiPV 5`)
    await page.locator(`${ENGINE} .analyze-multipv select`).selectOption('3')
    await waitForLines(page, 3)
    return `arrows: ${arrows5} (mpv5), ${arrows1} (mpv1)`
  })

  await check('engine toggle off clears lines, arrows and eval; on brings them back', async () => {
    await page.locator(`${ENGINE} label.ui-toggle`, { hasText: 'Engine' }).click()
    await waitForLines(page, 0, 3000)
    const empty = await page.locator(`${ENGINE} .engine-empty`).textContent()
    assert(/off/i.test(empty), `empty text "${empty}"`)
    // chessground redraws its SVG shapes on the next animation frame
    await page
      .waitForFunction((sel) => document.querySelectorAll(`${sel} svg.cg-shapes line`).length === 0, ROOT, { timeout: 2000 })
      .catch(() => {})
    assert((await arrowCount(page)) === 0, 'arrows left with engine off')
    const bar = await evalBar(page)
    assert(parseFloat(bar.white) === 50 && !/\d/.test(bar.label), `eval bar ${JSON.stringify(bar)}`)
    const stopSent = wsFrames.some((f) => f.includes('"stop":true'))
    assert(stopSent, 'no {stop:true} frame sent')
    await shot(page, '05-engine-off')
    await page.locator(`${ENGINE} label.ui-toggle`, { hasText: 'Engine' }).click()
    await waitForLines(page, 3)
    return 'stop frame sent, lines back after re-enabling'
  })

  await check('clicking a PV move plays the line up to that move', async () => {
    const plyBefore = await page.locator('.analyze-movelist .move-cell[data-ply]').count()
    await page.waitForFunction(
      (sel) => (document.querySelector(`${sel} .engine-line`)?.querySelectorAll('.pv-move').length ?? 0) >= 2,
      ENGINE,
      { timeout: 10000 },
    )
    const pvMoves = page.locator(`${ENGINE} .engine-line`).first().locator('.pv-move')
    const sans = await pvMoves.allTextContents()
    assert(sans.length >= 2, `pv ${sans.join(' ')}`)
    await pvMoves.nth(1).click()
    await page.waitForTimeout(300)
    const cells = await page.locator('.analyze-movelist .move-cell[data-ply]').allTextContents()
    assert(cells.length === plyBefore + 2, `${cells.length} moves after clicking (was ${plyBefore})`)
    assert(cells[cells.length - 1] === sans[1] && cells[cells.length - 2] === sans[0], `played ${cells.slice(-2)} vs pv ${sans.slice(0, 2)}`)
    return `played ${sans.slice(0, 2).join(' ')}`
  })

  await check('copy FEN puts the current FEN on the clipboard', async () => {
    await page.locator('[data-testid="analyze-copy-fen"]').click()
    await page.locator('[data-testid="analyze-copied"]').waitFor({ timeout: 2000 })
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    const fen = await fenOf(page)
    assert(clip === fen, `clipboard "${clip}" vs fen "${fen}"`)
    return clip
  })

  await check('copy PGN puts a PGN with the moves on the clipboard', async () => {
    await page.locator('[data-testid="analyze-copy-pgn"]').click()
    await page.waitForTimeout(200)
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    assert(clip.includes('1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Nf6 5.Ng5') && clip.includes('[Event'), `pgn ${clip}`)
    return clip.replace(/\n/g, ' ').slice(0, 120)
  })

  await check('flip turns the board', async () => {
    await page.locator('button[title="Flip board"]').click()
    await page.waitForTimeout(250)
    const o = await page.locator(ROOT).getAttribute('data-orientation')
    assert(o === 'black', `orientation ${o}`)
    const bar = await page.locator('[data-testid="analyze-board"] .eval-bar').getAttribute('class')
    assert(bar.includes('white-top'), `eval bar class ${bar}`)
    await shot(page, '06-flipped')
    await page.locator('button[title="Flip board"]').click()
  })

  const ITALIAN_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'
  await check('FEN import loads the position, clears the move list and analyses it', async () => {
    await sideTab(page, 'import')
    await page.locator('.analyze-import-text').fill(ITALIAN_FEN)
    await page.locator('[data-testid="analyze-import-load"]').click()
    await page.waitForTimeout(300)
    const fen = await fenOf(page)
    assert(fen === ITALIAN_FEN, `fen ${fen}`)
    const notice = await page.locator('[data-testid="analyze-notice"]').textContent()
    assert(/loaded/i.test(notice), notice)
    await waitForLines(page, 3)
    const status = await page.locator('[data-testid="analyze-opening"]').getAttribute('data-status')
    assert(status === 'custom', `opening status ${status}`)
    await page.waitForTimeout(800)
    await shot(page, '07-fen-import')
    return notice
  })

  await check('invalid FEN shows an error and keeps the board', async () => {
    await page.locator('.analyze-import-text').fill('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1')
    await page.locator('[data-testid="analyze-import-load"]').click()
    await page.waitForTimeout(200)
    const notice = await page.locator('[data-testid="analyze-notice"]').textContent()
    assert(/invalid/i.test(notice), notice)
    assert((await fenOf(page)) === ITALIAN_FEN, 'board changed')
    return notice
  })

  const PGN = `[Event "Casual"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Bd2 Bxd2+ 8. Nbxd2 d5 1-0`
  await check('PGN import loads the game at its last move and the opening card follows it', async () => {
    await page.locator('.analyze-import-text').fill(PGN)
    await page.locator('[data-testid="analyze-import-load"]').click()
    await page.waitForFunction(() => /PGN loaded/.test(document.querySelector('[data-testid="analyze-notice"]')?.textContent ?? ''), null, { timeout: 5000 })
    await sideTab(page, 'moves')
    const cells = await page.locator('.analyze-movelist .move-cell[data-ply]').count()
    assert(cells === 16, `${cells} moves`)
    const current = await page.locator('.analyze-movelist .move-cell.current').getAttribute('data-ply')
    assert(current === '16', `current ply ${current}`)
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-testid="analyze-opening"]')?.getAttribute('data-status')
      return s === 'book' || s === 'left'
    }, null, { timeout: 10000 })
    const card = await page.locator('[data-testid="analyze-opening"]').textContent()
    assert(/Italian/i.test(card), `opening card "${card}"`)
    await page.waitForTimeout(1200)
    await shot(page, '08-pgn-import')
    // PGN copy keeps the imported headers and result
    await page.locator('[data-testid="analyze-copy-pgn"]').click()
    await page.waitForTimeout(200)
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    assert(clip.includes('[White "Alice"]') && clip.trim().endsWith('1-0'), `pgn ${clip}`)
    return card.replace(/\s+/g, ' ').slice(0, 100)
  })

  await check('bad PGN shows the parser error', async () => {
    await sideTab(page, 'import')
    await page.locator('.analyze-import-text').fill('1. e4 Ke7 2. Qxf7')
    await page.locator('[data-testid="analyze-import-load"]').click()
    await page.waitForFunction(() => /Could not read/.test(document.querySelector('[data-testid="analyze-notice"]')?.textContent ?? ''), null, { timeout: 5000 })
    return await page.locator('[data-testid="analyze-notice"]').textContent()
  })

  await check('Set up position: edit the FEN, apply, and the engine analyses it', async () => {
    await sideTab(page, 'setup')
    const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1' // back-rank mate in one
    await page.locator('[data-testid="analyze-setup-fen"]').fill(fen)
    await page.locator('[data-testid="analyze-setup-apply"]').click()
    await page.waitForTimeout(300)
    assert((await fenOf(page)) === fen, `fen ${await fenOf(page)}`)
    await page.waitForFunction(
      (sel) => /M1/.test(document.querySelector(`${sel} .engine-score`)?.textContent ?? ''),
      ENGINE,
      { timeout: 15000 },
    )
    const bar = await evalBar(page)
    await shot(page, '09-setup-position-mate')
    // play the mate: Rd8#
    await playUci(page, ['d1d8'])
    await page.locator('[data-testid="analyze-gameover"]').waitFor({ timeout: 5000 })
    const over = await page.locator('[data-testid="analyze-gameover"]').textContent()
    assert(/Checkmate/.test(over), over)
    return `eval ${bar.label}; after Rd8: ${over.trim()}`
  })

  await check('Set up position rejects an invalid FEN', async () => {
    await page.locator('[data-testid="analyze-setup-fen"]').fill('8/8/8/8/8/8/8/8 w - - 0 1')
    await page.locator('[data-testid="analyze-setup-apply"]').click()
    await page.waitForTimeout(200)
    const notice = await page.locator('[data-testid="analyze-setup"] [data-testid="analyze-notice"]').textContent()
    assert(/invalid/i.test(notice), notice)
    return notice
  })

  await check('board state survives a tab switch, and leaving the tab stops the engine', async () => {
    await page.locator('[data-testid="analyze-setup"] button', { hasText: 'Initial position' }).click()
    await playUci(page, ['d2d4', 'd7d5'])
    const fen = await fenOf(page)
    const framesBefore = wsFrames.length
    const closedBefore = analyzeWsClosed
    await page.locator('.nav-item', { hasText: 'Learn' }).click()
    await page.waitForTimeout(800)
    assert(analyzeWsClosed > closedBefore, 'analysis socket not closed on unmount')
    const stopOnLeave = wsFrames.slice(framesBefore).some((f) => f.includes('"stop":true'))
    assert(stopOnLeave, 'no stop frame sent on unmount')
    await page.locator('.nav-item', { hasText: 'Analyze' }).click()
    await page.locator(`${ROOT} cg-board piece`).first().waitFor()
    assert((await fenOf(page)) === fen, `fen after coming back ${await fenOf(page)}`)
    await waitForLines(page, 3)
    return 'socket closed + stop sent on leave; position restored on return'
  })

  await check('Learn tab hand-off ("Analyze this position") is honoured if the Learn tab provides one', async () => {
    await page.locator('.nav-item', { hasText: 'Learn' }).click()
    await page.waitForTimeout(1500)
    const card = page.locator('.card.clickable, [data-testid^="learn-card"]').first()
    if ((await card.count()) === 0) return 'skipped: Learn tab has no opening cards yet'
    await card.click()
    await page.waitForTimeout(800)
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(250)
    }
    const btn = page.locator('button', { hasText: /Analy[sz]e this position/i }).first()
    if ((await btn.count()) === 0) return 'skipped: no "Analyze this position" button in Learn yet'
    await btn.click()
    await page.locator('[data-testid="analyze-tab"]').waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    const fen = await fenOf(page)
    const moves = await page.locator('.analyze-movelist .move-cell[data-ply]').allTextContents()
    await shot(page, '10-from-learn')
    return `analyze opened at ${fen} (moves: ${moves.join(' ') || 'none'})`
  })

  await check('narrow window (1100x720): board, engine lines, opening card and footer all fit', async () => {
    await page.setViewportSize({ width: 1100, height: 720 })
    await sideTab(page, 'import')
    await page.locator('.analyze-import-text').fill('1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nf6 5. Ng5')
    await page.locator('[data-testid="analyze-import-load"]').click()
    await page.waitForFunction(() => /PGN loaded/.test(document.querySelector('[data-testid="analyze-notice"]')?.textContent ?? ''), null, { timeout: 5000 })
    await sideTab(page, 'moves')
    await page.locator(`${ENGINE} .analyze-multipv select`).selectOption('5')
    await waitForLines(page, 5)
    await page.waitForTimeout(1000)
    const m = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect()
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        board: r('[data-testid="analyze-board"] .board-root')?.width ?? 0,
        footer: r('[data-testid="analyze-copy-pgn"]')?.bottom ?? 9999,
        toolbar: r('.analyze-toolbar')?.bottom ?? 9999,
        innerH: window.innerHeight,
      }
    })
    await shot(page, '11-narrow-1100x720')
    assert(m.scrollW <= m.innerW, `horizontal overflow ${m.scrollW} > ${m.innerW}`)
    assert(m.board >= 300, `board ${m.board}px`)
    assert(m.footer <= m.innerH && m.toolbar <= m.innerH, `cut off: footer ${m.footer}, toolbar ${m.toolbar}, height ${m.innerH}`)
    await page.locator(`${ENGINE} .analyze-multipv select`).selectOption('3')
    await page.setViewportSize({ width: 1500, height: 950 })
    return JSON.stringify(m)
  })

  await check('"Learn" on the opening card opens the Learn tab', async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="analyze-opening"]')?.getAttribute('data-status') === 'book', null, { timeout: 10000 })
    await page.locator('.analyze-opening-learn').click()
    await page.waitForTimeout(800)
    const active = await page.locator('.nav-item.active').textContent()
    assert(/Learn/.test(active), `active tab ${active}`)
    await shot(page, '12-opening-to-learn')
    await page.locator('.nav-item', { hasText: 'Analyze' }).click()
    await page.locator('[data-testid="analyze-tab"]').waitFor()
    return 'Learn tab opened'
  })

  await check('no console errors', async () => {
    // the bad-PGN check above gets an intended 400 from /api/pgn/parse, which Chrome logs as a failed resource
    let expected400 = 1
    const relevant = consoleErrors.filter((t) => {
      if (/favicon/i.test(t)) return false
      if (expected400 > 0 && /status of 400 \(Bad Request\)/.test(t)) {
        expected400 -= 1
        return false
      }
      return true
    })
    assert(relevant.length === 0, relevant.join(' | '))
  })
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
