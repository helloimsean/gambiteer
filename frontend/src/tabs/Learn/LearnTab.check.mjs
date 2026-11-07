// Playwright check of the Learn tab against the real backend (not bundled; run with node).
//
//   backend on :8000 and `npm run dev` running, then from frontend/:
//   node src/tabs/Learn/LearnTab.check.mjs [baseUrl]        (default http://localhost:5173)
//
// Screenshots go to frontend/screenshots/Learn-*.png. Exit code 0 = all checks passed.
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
    record(name, false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BOARD = '.learn-view .board-root'
const CURRENT = '[data-testid="learn-current-move"]'
const WHY = '[data-testid="learn-why"]'
const CATEGORY_ORDER = ['main', 'accepted', 'declined', 'alternative', 'sideline', 'trap', 'transposition']

async function fenOf(page) {
  return page.locator(BOARD).getAttribute('data-fen')
}
function findNode(root, id) {
  let node = root
  for (const san of id ? id.split(' ') : []) {
    node = node.children.find((c) => c.san === san)
    if (!node) return null
  }
  return node
}
/** Click a square of the Learn board (handles orientation). */
async function clickSquare(page, sq) {
  const box = await page.locator(BOARD).boundingBox()
  const orientation = await page.locator(BOARD).getAttribute('data-orientation')
  const f = 'abcdefgh'.indexOf(sq[0])
  const r = Number(sq[1]) - 1
  const x = orientation === 'white' ? f : 7 - f
  const y = orientation === 'white' ? 7 - r : r
  await page.mouse.click(box.x + ((x + 0.5) * box.width) / 8, box.y + ((y + 0.5) * box.height) / 8)
}
async function openPanel(page, label) {
  await page.locator('.learn-side .panel-tabs button', { hasText: label }).click()
}
async function shot(page, name) {
  await sleep(450) // let board animations finish (chessground redraws arrows at the end)
  await page.screenshot({ path: join(SHOTS, `Learn-${name}.png`) })
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const openings = await (await page.request.get(`${BASE}/api/openings`)).json()
const alien = await (await page.request.get(`${BASE}/api/openings/alien-gambit`)).json()
console.log(`backend: ${openings.length} openings (${openings.map((o) => o.id).join(', ')})`)

await page.goto(BASE)
await page.evaluate(() => localStorage.removeItem('learn-last-v1'))
await page.reload()

// ---------------------------------------------------------------- gallery
await check('gallery renders a card for every opening', async () => {
  await page.locator('.learn-card').first().waitFor({ timeout: 10000 })
  const ids = await page.locator('.learn-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-opening-id')))
  for (const o of openings) assert(ids.includes(o.id), `missing card ${o.id}`)
  assert(ids.length === openings.length, `${ids.length} cards for ${openings.length} openings`)
  const pieces = await page.locator('.learn-card .learn-mini-board piece').count()
  assert(pieces >= 20 * openings.length, `mini boards show ${pieces} pieces`)
  return `${ids.length} cards: ${ids.join(', ')}`
})
await check('cards show name, side badge, ECO, line count and summary', async () => {
  const card = page.locator('.learn-card[data-opening-id="alien-gambit"]')
  const text = await card.innerText()
  assert(text.includes(alien.name), 'name')
  assert(text.includes('White'), 'side badge')
  assert(text.includes(alien.eco), 'eco')
  assert(text.includes(`${alien.lineCount} lines`), 'line count')
  assert((await card.locator('.learn-card-summary').innerText()).length > 20, 'summary')
})
await check('side filter and search', async () => {
  await page.locator('.learn-gallery .btn-group button', { hasText: 'As Black' }).click()
  const black = await page.locator('.learn-card').count()
  assert(black === openings.filter((o) => o.side === 'black').length, `black filter shows ${black}`)
  await page.locator('.learn-gallery .btn-group button', { hasText: 'All' }).click()
  await page.locator('.learn-search').fill('vienna')
  assert((await page.locator('.learn-card').count()) === 1, 'search vienna')
  await page.locator('.learn-search').fill('')
})
await shot(page, '01-gallery')

// ---------------------------------------------------------------- opening view
await check('opening view shows board (student side) + tree', async () => {
  await page.locator('.learn-card[data-opening-id="alien-gambit"]').click()
  await page.locator(BOARD).waitFor({ timeout: 10000 })
  await page.locator('.learn-tree .learn-tree-move').first().waitFor()
  assert((await page.locator(BOARD).getAttribute('data-orientation')) === 'white', 'orientation')
  const moves = await page.locator('.learn-tree .learn-tree-move').count()
  const mainBold = await page.locator('.learn-tree .learn-tree-move.mainline').count()
  assert(moves > 50, `tree moves ${moves}`)
  assert(mainBold > 10, `bold main-line moves ${mainBold}`)
  const weight = await page.locator('.learn-tree .learn-tree-move.mainline').first().evaluate((e) => getComputedStyle(e).fontWeight)
  assert(Number(weight) >= 700, `main line font weight ${weight}`)
  return `${moves} moves in the tree, ${mainBold} main-line`
})
await check('line chips sit on the first node unique to each line', async () => {
  const chips = await page.locator('.learn-tree .learn-chip[data-line-id]').evaluateAll((els) =>
    els.map((e) => ({ line: e.getAttribute('data-line-id'), node: e.previousElementSibling?.getAttribute('data-node-id') ?? null })),
  )
  assert(chips.length > 0, 'no chips')
  for (const c of chips) {
    const line = alien.lines.find((l) => l.id === c.line)
    assert(line, `unknown line ${c.line}`)
    // the chip follows the move token (possibly after other chips): find the token before it
    const node = c.node ? findNode(alien.tree, c.node) : null
    if (node) {
      const unique = node.lineIds.length === 1 && node.lineIds[0] === line.id
      const isEnd = node.ply === line.sans.length
      assert(unique || isEnd, `chip ${c.line} on non-unique node ${c.node}`)
    }
  }
  return `${chips.length} chips visible (variations deeper than level 1 start collapsed)`
})
await shot(page, '02-opening-view')

const NXF7 = 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Ng5 h6 Nxf7'
await check('clicking a tree node moves the board and shows the why', async () => {
  const node = findNode(alien.tree, NXF7)
  await page.locator(`.learn-tree-move[data-node-id="${NXF7}"]`).first().click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('6.Nxf7'), CURRENT)
  assert((await fenOf(page)) === node.fen, 'fen after click')
  const why = await page.locator(WHY).innerText()
  assert(why.includes(node.why.slice(0, 40)), `why text: ${why.slice(0, 60)}`)
  assert(await page.locator(`.learn-tree-move.selected[data-node-id="${NXF7}"]`).count(), 'selected highlight')
  const shapes = await page.locator(`${BOARD} .cg-shapes g, ${BOARD} svg.cg-shapes g`).count()
  return `board ${node.fen.split(' ')[0]}, nag "${node.nag}", ${shapes} arrow groups`
})
await shot(page, '03-node-why')

await check('keyboard navigation (arrows, Home, End)', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('6…Kxf7'), CURRENT)
  assert((await fenOf(page)) === findNode(alien.tree, `${NXF7} Kxf7`).fen, 'fen after ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('5…h6'), CURRENT)
  await page.keyboard.press('Home')
  await page.waitForFunction(() => document.querySelector('.learn-move-big')?.textContent?.includes('Starting position'))
  await page.keyboard.press('End')
  await sleep(300)
  const label = await page.locator('.learn-ply-count').innerText()
  const [a, b] = label.split('/').map(Number)
  assert(a === b && a > 10, `End -> ${label}`)
  assert(await page.locator('.learn-end').count(), 'end-of-line note')
  return `End reached ply ${label}`
})

// Practice (auto-reply, coach card) has its own check: LearnPractice.check.mjs.
await check('board move in the tree navigates and the opponent replies; off-book move stays until taken back', async () => {
  await page.keyboard.press('Home')
  await sleep(250)
  await clickSquare(page, 'e2')
  await clickSquare(page, 'e4')
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('1.e4'), CURRENT)
  // auto-reply (default on): the opponent answers with a move of the tree
  const e4 = findNode(alien.tree, 'e4')
  const replies = e4.children.map((c) => c.fen)
  await page.waitForFunction(([sel, fens]) => fens.includes(document.querySelector(sel)?.getAttribute('data-fen')), [BOARD, replies], { timeout: 2500 })
  const before = await fenOf(page)
  const reply = e4.children.find((c) => c.fen === before)
  // 2.h4 is not in the Alien Gambit tree: it stays on the board with a verdict until taken back
  assert(!reply.children.some((c) => c.san === 'h4'), '2.h4 is in the tree')
  await clickSquare(page, 'h2')
  await clickSquare(page, 'h4')
  await page.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 3000 })
  assert((await fenOf(page)) !== before, 'off-book move not shown on the board')
  await page.locator('[data-testid="learn-takeback"]').click()
  await page.waitForFunction(([sel, f]) => document.querySelector(sel)?.getAttribute('data-fen') === f, [BOARD, before], { timeout: 2000 })
  return `1.e4 ${reply.san}; 2.h4 shown off book, then taken back`
})

await check('autoplay advances 1 move / 1.5 s', async () => {
  await page.keyboard.press('Home')
  await sleep(200)
  await page.locator('.learn-controls button[title^="Autoplay"]').click()
  await sleep(3300)
  const [a] = (await page.locator('.learn-ply-count').innerText()).split('/').map(Number)
  await page.locator('.learn-controls button[title="Pause autoplay"]').click()
  assert(a === 2, `after 3.3 s ply = ${a}`)
  return 'ply 2 after 3.3 s'
})

// ---------------------------------------------------------------- lines panel
await check('Lines panel groups in the required order', async () => {
  await openPanel(page, 'Lines')
  const cats = await page.locator('.learn-line-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-category')))
  const expected = CATEGORY_ORDER.filter((c) => alien.lines.some((l) => l.category === c))
  assert(JSON.stringify(cats) === JSON.stringify(expected), `got ${cats.join(',')}`)
  const titles = await page.locator('.learn-line-group-title').allInnerTexts()
  return titles.map((t) => t.replace(/\s+/g, ' ')).join(' | ')
})
await check('gambit shows a prominent "If declined" section', async () => {
  const box = page.locator('.learn-lines .learn-declined')
  await box.waitFor()
  const n = await box.locator('.learn-declined-item').count()
  const declined = alien.lines.filter((l) => l.category === 'declined').length
  assert(n === declined, `${n} items, ${declined} declined lines`)
})
const TRAP = alien.lines.find((l) => l.id === 'alien-c5-d5-trap') ?? alien.lines.find((l) => l.category === 'trap')
await check('selecting a line loads it, shows description/evaluation, highlights path', async () => {
  await page.locator(`.learn-line[data-line-id="${TRAP.id}"] .learn-line-head`).click()
  const body = page.locator(`.learn-line.active[data-line-id="${TRAP.id}"] .learn-line-body`)
  await body.waitFor()
  const text = await body.innerText()
  assert(text.includes(TRAP.description.slice(0, 30)), 'description')
  assert(!TRAP.evaluation || text.includes(TRAP.evaluation.slice(0, 20)), 'evaluation')
  const fen = await fenOf(page)
  const nodes = []
  let n = alien.tree
  for (const s of TRAP.sans) {
    n = n.children.find((c) => c.san === s)
    nodes.push(n)
  }
  assert(nodes.some((x) => x.fen === fen), 'board not on the line')
  await shot(page, '04-lines')
  await openPanel(page, 'Tree')
  await sleep(300)
  const onLine = await page.locator('.learn-tree .learn-tree-move.on-line, .learn-tree .learn-tree-move.selected').count()
  assert(onLine >= TRAP.sans.length, `highlighted ${onLine} of ${TRAP.sans.length}`)
  return `${TRAP.name}: ${onLine} highlighted tree moves`
})
await shot(page, '05-tree-line-highlight')

await check('Ideas panel: summary, ECO, ideas, plans, mistakes, source links', async () => {
  await openPanel(page, 'Ideas')
  const ideas = page.locator('.learn-ideas')
  await ideas.waitFor()
  const text = await ideas.innerText()
  assert(text.includes(alien.summary.slice(0, 40)), 'summary')
  assert(text.includes(alien.eco), 'eco')
  for (const h of ['KEY IDEAS', 'TYPICAL PLANS', 'COMMON MISTAKES', 'SOURCES']) assert(text.toUpperCase().includes(h), h)
  const links = await ideas.locator('.learn-sources a[href^="http"]').count()
  assert(links === alien.sources.length, `${links} links`)
  return `${links} source links`
})
await shot(page, '06-ideas')

// ---------------------------------------------------------------- hand-offs
await check('"Quiz this opening" navigates to Quiz', async () => {
  await page.locator('button[title="Quiz this opening"]').click()
  await page.waitForFunction(() => document.querySelector('.nav-item[aria-current="page"] span')?.textContent === 'Quiz')
  await sleep(500)
  await shot(page, '07-quiz-handoff')
})
await check('returning to Learn restores the opening view', async () => {
  await page.locator('.nav-item', { hasText: 'Learn' }).click()
  await page.locator(BOARD).waitFor({ timeout: 10000 })
  assert((await page.locator('.learn-side-title').innerText()).includes(alien.name), 'same opening')
})
await check('"Analyze this position" navigates to Analyze with the moves', async () => {
  await openPanel(page, 'Tree')
  await page.locator(`.learn-tree-move[data-node-id="${NXF7}"]`).first().click()
  await sleep(300)
  await page.locator('button[title="Analyze this position"]').click()
  await page.waitForFunction(() => document.querySelector('.nav-item[aria-current="page"] span')?.textContent === 'Analyze')
  await sleep(1500)
  const fen = await page.locator('.board-root').first().getAttribute('data-fen')
  const want = findNode(alien.tree, NXF7).fen
  await shot(page, '08-analyze-handoff')
  assert(fen === want, `Analyze board ${fen}`)
  return 'Analyze board is at 6.Nxf7'
})
await check('learnRequest from another tab opens Learn at that node', async () => {
  const learnBtn = page.locator('.analyze-opening-learn').first()
  if (!(await learnBtn.count())) return 'skipped: Analyze has no Learn button here'
  const name = (await page.locator('[data-testid="analyze-opening-name"]').first().innerText()).trim()
  await learnBtn.click()
  await page.locator(BOARD).waitFor({ timeout: 10000 })
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('Nxf7'), CURRENT, { timeout: 5000 })
  const title = await page.locator('.learn-side-title').innerText()
  assert(title.includes(name), `opened ${title} (Analyze said ${name})`)
  await shot(page, '09-learn-request')
  return `opened ${name} at 6.Nxf7`
})

// ---------------------------------------------------------------- black repertoire + back
await check('a Black repertoire opens with the board flipped', async () => {
  const black = openings.find((o) => o.side === 'black')
  if (!black) return 'skipped: no black opening'
  await page.locator('.learn-side-header button[title="All openings"]').click()
  await page.locator(`.learn-card[data-opening-id="${black.id}"]`).click()
  await page.locator(BOARD).waitFor()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-orientation') === 'black', BOARD)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await sleep(400)
  await shot(page, '10-black-side')
  return black.name
})
await check('Queen\'s/other gambits list their declined lines', async () => {
  const g = openings.find((o) => /gambit/i.test(o.name) && o.id !== 'alien-gambit' && (o.categoriesCount.declined ?? 0) > 0)
  if (!g) return 'skipped'
  await page.locator('.learn-side-header button[title="All openings"]').click()
  await page.locator(`.learn-card[data-opening-id="${g.id}"]`).click()
  await page.locator(BOARD).waitFor()
  await openPanel(page, 'Lines')
  const n = await page.locator('.learn-lines .learn-declined .learn-declined-item').count()
  assert(n === g.categoriesCount.declined, `${n} vs ${g.categoriesCount.declined}`)
  await shot(page, '11-gambit-declined')
  return `${g.name}: ${n} declined lines`
})

// ---------------------------------------------------------------- narrow window
await check('nothing breaks at 1100 x 760', async () => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await openPanel(page, 'Tree')
  await sleep(400)
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.learn-below')
    const r = el.getBoundingClientRect()
    return { bottom: r.bottom, vh: window.innerHeight, docW: document.documentElement.scrollWidth, vw: window.innerWidth }
  })
  assert(overflow.bottom <= overflow.vh + 1, `controls overflow the viewport (${overflow.bottom} > ${overflow.vh})`)
  assert(overflow.docW <= overflow.vw, 'horizontal overflow')
  const quizVisible = await page.locator('button[title="Quiz this opening"]').isVisible()
  assert(quizVisible, 'quiz button hidden')
  await shot(page, '12-narrow')
})

await check('a remembered opening that no longer exists falls back to the gallery', async () => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => localStorage.setItem('learn-last-v1', JSON.stringify({ openingId: 'no-such-opening', nodeId: '', lineId: null })))
  await page.reload()
  await page.locator('.learn-card').first().waitFor({ timeout: 10000 })
})
await check('full HD layout (1920 x 1080), mid-line position', async () => {
  await page.locator('.learn-card[data-opening-id="alien-gambit"]').click()
  await page.locator(BOARD).waitFor()
  await page.locator(`.learn-tree-move[data-node-id="${NXF7} Kxf7 Nf3"]`).first().click()
  await shot(page, '13-full-hd')
  const quizText = await page.locator('button[title="Quiz this opening"]').innerText()
  assert(quizText.includes('Quiz this opening'), `label "${quizText}"`)
})
// the 404 for the missing opening above is expected; drop it from the console list
for (let i = consoleErrors.length - 1; i >= 0; i--) if (/status of 404/.test(consoleErrors[i])) consoleErrors.splice(i, 1)

record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
