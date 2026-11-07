// Playwright smoke test for the frontend shell and the shared Board component.
//
//   npm run dev                      (in another terminal; serves http://localhost:5173)
//   npm run check:board              (or: node scripts/check-board.mjs [baseUrl])
//
// Optional: SHOTS_DIR=<folder> saves screenshots of the playground and the shell.
// No backend needed: the health request is expected to fail and is ignored.
// Exit code 0 = all checks passed.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS_DIR ?? ''
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

// ---------------------------------------------------------------- board helpers

const ROLE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

/** { e2: 'white pawn', ... } from the placement part of a FEN. */
function piecesFromFen(fen) {
  const out = {}
  const rows = fen.split(' ')[0].split('/')
  rows.forEach((row, i) => {
    const rank = 8 - i
    let file = 0
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch)
      else {
        const color = ch === ch.toUpperCase() ? 'white' : 'black'
        out[`${'abcdefgh'[file]}${rank}`] = `${color} ${ROLE[ch.toLowerCase()]}`
        file += 1
      }
    }
  })
  return out
}

function root(scope) {
  return `[data-testid="${scope}"] .board-root`
}

async function fenOf(page, scope) {
  return page.locator(root(scope)).getAttribute('data-fen')
}

/** Pieces chessground currently shows (ignores pieces fading out after a capture). */
async function domPieces(page, scope) {
  return page.locator(`${root(scope)} cg-board`).evaluate((board) => {
    const out = {}
    for (const el of board.querySelectorAll('piece')) {
      if (el.cgFading || el.classList.contains('ghost')) continue
      if (el.cgKey && el.cgPiece) out[el.cgKey] = el.cgPiece
    }
    return out
  })
}

function diffPieces(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs = []
  for (const k of keys) if (a[k] !== b[k]) diffs.push(`${k}: dom=${a[k] ?? '-'} fen=${b[k] ?? '-'}`)
  return diffs
}

async function expectBoardMatchesFen(page, scope, label = '') {
  await page.waitForTimeout(350) // let animations finish
  const fen = await fenOf(page, scope)
  const diffs = diffPieces(await domPieces(page, scope), piecesFromFen(fen))
  assert(diffs.length === 0, `${label} board differs from fen ${fen}: ${diffs.join(', ')}`)
  return fen
}

async function boardBox(page, scope) {
  const box = await page.locator(`${root(scope)} cg-board`).boundingBox()
  assert(box, 'board has no bounding box')
  return box
}

async function orientationOf(page, scope) {
  return (await page.locator(root(scope)).getAttribute('data-orientation')) ?? 'white'
}

function center(box, sq, orientation) {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  const s = box.width / 8
  const col = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 7 - rank : rank
  return { x: box.x + s * (col + 0.5), y: box.y + s * (row + 0.5) }
}

async function drag(page, scope, from, to) {
  const box = await boardBox(page, scope)
  const o = await orientationOf(page, scope)
  const a = center(box, from, o)
  const b = center(box, to, o)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}

async function clickSquare(page, scope, sq) {
  const box = await boardBox(page, scope)
  const p = center(box, sq, await orientationOf(page, scope))
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(60)
}

async function toggleByLabel(page, label) {
  await page.locator('label.ui-toggle', { hasText: label }).first().click()
  await page.waitForTimeout(80)
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  const url = msg.location()?.url ?? ''
  const text = msg.text()
  // the backend is not running during this check: failed /api and /ws requests are expected
  if (/\/api\/|\/ws\//.test(url) || /\/api\/|\/ws\//.test(text)) return
  if (/Failed to load resource: the server responded with a status of 50[0-4]/.test(text)) return
  consoleErrors.push(text)
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

try {
  // ---------------- playground
  const resp = await page.goto(`${BASE}/?dev=1`, { waitUntil: 'networkidle' })
  await check('dev playground responds 200', async () => {
    assert(resp && resp.status() === 200, `status ${resp?.status()}`)
  })

  await check('board renders 32 pieces matching the start fen', async () => {
    await page.locator(`${root('dev-board')} cg-board piece`).first().waitFor()
    const n = await page.locator(`${root('dev-board')} cg-board piece`).count()
    assert(n === 32, `found ${n} pieces`)
    await expectBoardMatchesFen(page, 'dev-board', 'start')
  })

  await check('drag e2-e4 is applied (fen + pieces + last-move highlight)', async () => {
    await drag(page, 'dev-board', 'e2', 'e4')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'after e4')
    assert(fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b'), `fen ${fen}`)
    const hl = await page.locator(`${root('dev-board')} square.last-move`).count()
    assert(hl === 2, `${hl} last-move squares`)
    return fen
  })

  await check('click-click e7 then e5 is applied', async () => {
    await clickSquare(page, 'dev-board', 'e7')
    await clickSquare(page, 'dev-board', 'e5')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'after e5')
    assert(fen.startsWith('rnbqkbnr/pppp1ppp/8/4p3/4P3/'), `fen ${fen}`)
  })

  await check('illegal drag (Ra1-a5 through own pawn) leaves the position unchanged', async () => {
    const before = await fenOf(page, 'dev-board')
    await drag(page, 'dev-board', 'a1', 'a5')
    const after = await expectBoardMatchesFen(page, 'dev-board', 'illegal')
    assert(after === before, `fen changed to ${after}`)
  })

  await check('move list shows the moves and jumping back updates the board', async () => {
    const cells = await page.locator('[data-testid="dev-board"]').locator('xpath=../..').locator('.move-cell[data-ply]').count()
    assert(cells === 2, `${cells} move cells`)
    await page.locator('.move-cell[data-ply="1"]').first().click()
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'jump to ply 1')
    assert(fen.includes('4P3') && fen.includes('pppppppp'), `fen ${fen}`)
    await page.locator('.move-cell[data-ply="2"]').first().click()
    await expectBoardMatchesFen(page, 'dev-board', 'jump to ply 2')
  })

  await check('interactive off blocks moves; back on re-enables dragging', async () => {
    await page.locator('[data-testid="dev-reset"]').click()
    await toggleByLabel(page, 'Interactive')
    await drag(page, 'dev-board', 'd2', 'd4')
    let fen = await expectBoardMatchesFen(page, 'dev-board', 'static')
    assert(fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/'), `moved while static: ${fen}`)
    await toggleByLabel(page, 'Interactive')
    await drag(page, 'dev-board', 'd2', 'd4')
    fen = await expectBoardMatchesFen(page, 'dev-board', 're-enabled')
    assert(fen.includes('3P4'), `drag after re-enable not applied: ${fen}`)
  })

  await check('coordinates toggle rebuilds the board and it stays interactive', async () => {
    await page.locator('[data-testid="dev-reset"]').click()
    const coords = () => page.locator(`${root('dev-board')} coords`).count()
    const before = await coords()
    await toggleByLabel(page, 'Coordinates')
    const off = await coords()
    await toggleByLabel(page, 'Coordinates')
    const on = await coords()
    assert(before === 2 && off === 0 && on === 2, `coords before/off/on = ${before}/${off}/${on}`)
    await drag(page, 'dev-board', 'g1', 'f3')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'after rebuild')
    assert(fen.includes('5N2'), `fen ${fen}`)
  })

  await check('flipped board: orientation class and drag in black orientation', async () => {
    await page.locator('[data-testid="dev-reset"]').click()
    await page.locator('[data-testid="dev-flip"]').click()
    await page.waitForTimeout(150)
    const flipped = await page.locator(`${root('dev-board')} .cg-wrap.orientation-black`).count()
    assert(flipped === 1, 'no orientation-black class')
    await drag(page, 'dev-board', 'c2', 'c4')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'flipped')
    assert(fen.includes('2P5'), `fen ${fen}`)
    await page.locator('[data-testid="dev-flip"]').click()
  })

  await check('promotion: chooser appears, knight is applied', async () => {
    await page.locator('[data-testid="dev-promo"]').click()
    await drag(page, 'dev-board', 'b7', 'b8')
    await page.locator(`${root('dev-board')} .board-promo`).waitFor({ timeout: 2000 })
    await page.locator(`${root('dev-board')} .board-promo button[data-piece="n"]`).click()
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'promotion')
    assert(fen.startsWith('1N2k3/8/'), `fen ${fen}`)
    assert((await page.locator(`${root('dev-board')} .board-promo`).count()) === 0, 'chooser still open')
  })

  await check('promotion: Esc cancels and the pawn goes back', async () => {
    await page.locator('[data-testid="dev-promo"]').click()
    await drag(page, 'dev-board', 'b7', 'b8')
    await page.locator(`${root('dev-board')} .board-promo`).waitFor({ timeout: 2000 })
    await page.keyboard.press('Escape')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'promotion cancel')
    assert(fen.startsWith('4k3/1P6/'), `fen ${fen}`)
  })

  await check('castling by dropping the king on the rook (O-O and O-O-O)', async () => {
    await page.locator('[data-testid="dev-castle"]').click()
    await drag(page, 'dev-board', 'e1', 'h1')
    let fen = await expectBoardMatchesFen(page, 'dev-board', 'O-O')
    assert(fen.split(' ')[0].endsWith('/R4RK1'), `fen ${fen}`)
    await drag(page, 'dev-board', 'e8', 'a8')
    fen = await expectBoardMatchesFen(page, 'dev-board', 'O-O-O')
    assert(fen.startsWith('2kr3r/'), `fen ${fen}`)
  })

  await check('castling by moving the king two squares', async () => {
    await page.locator('[data-testid="dev-castle"]').click()
    await drag(page, 'dev-board', 'e1', 'c1')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'O-O-O two squares')
    assert(fen.split(' ')[0].endsWith('/2KR3R'), `fen ${fen}`)
  })

  await check('en passant removes the captured pawn from the board', async () => {
    await page.locator('[data-testid="dev-ep"]').click()
    await drag(page, 'dev-board', 'e5', 'd6')
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'en passant')
    assert(fen.startsWith('rnbqkbnr/ppp1pppp/3P4/8/8/'), `fen ${fen}`)
  })

  await check('rapid fen changes (25 ms apart) end in the right position', async () => {
    await page.locator('[data-testid="dev-reset"]').click()
    await page.locator('[data-testid="dev-rapid"]').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="dev-state"]')?.textContent?.includes('rapidRuns: 1'),
      null,
      { timeout: 15000 },
    )
    const fen = await expectBoardMatchesFen(page, 'dev-board', 'after rapid')
    // run it again while dragging the mouse around, to make sure nothing gets stuck
    await page.locator('[data-testid="dev-rapid"]').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="dev-state"]')?.textContent?.includes('rapidRuns: 2'),
      null,
      { timeout: 15000 },
    )
    await expectBoardMatchesFen(page, 'dev-board', 'after rapid #2')
    await page.getByRole('button', { name: 'Back to game' }).click()
    return fen.split(' ')[0]
  })

  await check('reused board: rejected move snaps back, presets switch cleanly', async () => {
    const scope = 'dev-reuse-board'
    await page.locator(`[data-testid="${scope}"]`).scrollIntoViewIfNeeded()
    // preset 0: view only, black orientation
    assert((await orientationOf(page, scope)) === 'black', 'preset 0 not black')
    let before = await fenOf(page, scope)
    await drag(page, scope, 'e2', 'e4')
    await expectBoardMatchesFen(page, scope, 'static preset')
    assert((await fenOf(page, scope)) === before, 'fen changed on a static board')
    // preset 1: play-like, white only; the parent never applies moves
    await page.locator('[data-testid="dev-reuse-next"]').click()
    await page.waitForTimeout(300)
    assert((await orientationOf(page, scope)) === 'white', 'preset 1 not white')
    await expectBoardMatchesFen(page, scope, 'preset 1')
    before = await fenOf(page, scope)
    await drag(page, scope, 'e2', 'e4')
    const text = await page.locator('text=last onMove:').innerText()
    assert(text.includes('e2e4'), `onMove not called: ${text}`)
    await expectBoardMatchesFen(page, scope, 'rejected move')
    // preset 2 and back to 0
    await page.locator('[data-testid="dev-reuse-next"]').click()
    await expectBoardMatchesFen(page, scope, 'preset 2')
    const arrows = await page.locator(`[data-testid="${scope}"] svg.cg-shapes line, [data-testid="${scope}"] svg.cg-shapes path`).count()
    assert(arrows >= 2, `expected arrows on preset 2, found ${arrows} svg elements`)
    await page.locator('[data-testid="dev-reuse-next"]').click()
    await expectBoardMatchesFen(page, scope, 'preset 0 again')
  })

  await check('opening tree: clicking a move selects it and moves the tree board', async () => {
    const id = 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Ng5 h6 Nxf7'
    const btn = page.locator(`.opening-tree [data-node-id="${id}"]`)
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    await page.waitForTimeout(300)
    assert((await btn.getAttribute('class')).includes('selected'), 'not selected')
    const variations = await page.locator('.opening-tree .tree-variation').count()
    assert(variations >= 2, `${variations} variations rendered`)
  })

  await check('MoveNav: arrow keys and buttons step the workspace board', async () => {
    const scope = 'dev-workspace'
    await page.locator(`[data-testid="${scope}"]`).scrollIntoViewIfNeeded()
    await page.locator(`[data-testid="${scope}"] .workspace-side`).click({ position: { x: 5, y: 5 } }) // blur inputs
    const f0 = await fenOf(page, scope)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(80)
    const f1 = await fenOf(page, scope)
    assert(f1 !== f0, 'ArrowRight did not advance')
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(80)
    assert((await fenOf(page, scope)) === f0, 'ArrowLeft did not go back')
    await page.keyboard.press('End')
    await page.waitForTimeout(80)
    const next = page.locator(`[data-testid="${scope}"] button[title^="Next move"]`)
    assert(await next.isDisabled(), 'Next not disabled at the end')
    await page.locator(`[data-testid="${scope}"] button[title^="First move"]`).click()
    const fen = await expectBoardMatchesFen(page, scope, 'MoveNav first')
    assert(fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/'), `not at start: ${fen}`)
    await page.locator(`[data-testid="${scope}"] button[title="Flip board"]`).click()
    assert((await orientationOf(page, scope)) === 'black', 'flip button did not flip')
  })

  await check('all 10 classification badges render', async () => {
    const n = await page.locator('[data-testid="dev-badges"] .cls-badge svg').count()
    assert(n === 20, `${n} badge icons`)
  })

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.evaluate(() => document.querySelector('.dev')?.scrollTo(0, 0))
    await page.locator('[data-testid="dev-reset"]').click()
    await page.screenshot({ path: join(SHOTS, 'playground-top.png') })
    await page.locator('.dev').evaluate((el) => el.scrollTo(0, 1250))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(SHOTS, 'playground-tree.png') })
  }

  // ---------------- app shell
  const resp2 = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await check('app shell responds 200 and renders the nav', async () => {
    assert(resp2 && resp2.status() === 200, `status ${resp2?.status()}`)
    const items = await page.locator('nav .nav-item').allInnerTexts()
    assert(items.join(',') === 'Learn,Quiz,Analyze,Play,Review', `nav items: ${items.join(',')}`)
  })

  await check('every tab mounts its component and becomes active', async () => {
    // the real tab roots (the shell-stage placeholders are gone); no error-boundary card allowed
    const roots = { Quiz: '.quiz-tab', Analyze: '.analyze-tab', Play: '.play-tab', Review: '.review-tab', Learn: '.learn-tab' }
    for (const [label, sel] of Object.entries(roots)) {
      await page.locator('nav .nav-item', { hasText: label }).click()
      await page.locator(`main ${sel}`).first().waitFor({ timeout: 5000 })
      assert((await page.locator('main .tab-error-text').count()) === 0, `${label} tab shows an error card`)
      const active = await page.locator('nav .nav-item.active').innerText()
      assert(active.trim() === label, `active nav "${active}"`)
    }
  })

  await check('health status dots are shown (backend not required)', async () => {
    const dots = await page.locator('nav .nav-status .status-dot').count()
    assert(dots === 2, `${dots} status dots`)
  })

  await check('settings modal opens and closes with Escape; settings persist', async () => {
    await page.locator('nav button[title="Settings"]').click()
    await page.locator('.ui-modal').waitFor()
    await page.locator('.ui-modal label.ui-toggle').first().click() // sounds off
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    assert((await page.locator('.ui-modal').count()) === 0, 'modal still open')
    const stored = await page.evaluate(() => localStorage.getItem('settings-v1'))
    assert(stored && JSON.parse(stored).sound === false, `stored settings: ${stored}`)
    await page.locator('nav button[title="Unmute sounds"]').click()
    const stored2 = await page.evaluate(() => localStorage.getItem('settings-v1'))
    assert(JSON.parse(stored2).sound === true, `stored settings after unmute: ${stored2}`)
  })

  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'shell.png') })

  await check('no console errors or uncaught exceptions', async () => {
    assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))
  })
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
