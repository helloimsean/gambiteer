// Playwright check of Learn-tab practice (auto-reply + coach) against the real backend.
//
//   cd frontend && npm run build
//   cd backend  && python -m uvicorn app.main:app --port 8012        (serves frontend/dist)
//   cd frontend && node src/tabs/Learn/LearnPractice.check.mjs [baseUrl]   (default http://localhost:8012)
//
// Needs Stockfish and Ollama with llama3.2:3b (the fast model the check selects in the settings).
// CHECK_GPT_OSS=1 also gets one explanation from gpt-oss:20b. Screenshots go to
// frontend/screenshots/learn-practice-*.png. Exit code 0 = all checks passed.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8012'
const FAST_MODEL = 'llama3.2:3b'
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
const BELOW = '.learn-view .learn-below'
const CARD = '[data-testid="learn-why"]'
const ROW = '[data-testid="learn-coach-row"]'

async function api(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}
function findNode(root, id) {
  let node = root
  for (const san of id ? id.split(' ') : []) {
    node = node.children.find((c) => c.san === san)
    if (!node) return null
  }
  return node
}
/** Placement, side to move and castling (en passant squares differ between chess.js and python-chess). */
const board4 = (fen) => (fen ?? '').split(' ').slice(0, 3).join(' ')

// ---------------------------------------------------------------- browser
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

/** Frames on /ws/coach (all sockets of the page). */
const wsSent = []
const wsRecv = []
let coachSockets = 0
page.on('websocket', (ws) => {
  if (!ws.url().includes('/ws/coach')) return
  coachSockets += 1
  ws.on('framesent', (f) => {
    try {
      wsSent.push(JSON.parse(String(f.payload)))
    } catch {
      /* ignore */
    }
  })
  ws.on('framereceived', (f) => {
    try {
      wsRecv.push(JSON.parse(String(f.payload)))
    } catch {
      /* ignore */
    }
  })
})

async function fenOf(p = page) {
  return p.locator(BOARD).getAttribute('data-fen')
}
async function belowAttr(name, p = page) {
  return p.locator(BELOW).getAttribute(name)
}
/** Click a square of the Learn board (handles orientation). */
async function clickSquare(sq, p = page) {
  const box = await p.locator(BOARD).boundingBox()
  const orientation = await p.locator(BOARD).getAttribute('data-orientation')
  const f = 'abcdefgh'.indexOf(sq[0])
  const r = Number(sq[1]) - 1
  const x = orientation === 'white' ? f : 7 - f
  const y = orientation === 'white' ? 7 - r : r
  await p.mouse.click(box.x + ((x + 0.5) * box.width) / 8, box.y + ((y + 0.5) * box.height) / 8)
}
async function play(uci, p = page) {
  await clickSquare(uci.slice(0, 2), p)
  await clickSquare(uci.slice(2, 4), p)
}
async function waitFen(want, timeout = 2000, p = page) {
  const t0 = Date.now()
  await p.waitForFunction(([sel, w]) => (document.querySelector(sel)?.getAttribute('data-fen') ?? '').split(' ').slice(0, 3).join(' ') === w, [BOARD, board4(want)], { timeout })
  return Date.now() - t0
}
async function shot(name, p = page) {
  await sleep(350) // board animation
  await p.screenshot({ path: join(SHOTS, `learn-practice-${name}.png`) })
}
async function openOpening(id, p = page) {
  const back = p.locator('.learn-side-header button[title="All openings"]')
  if (await back.count()) await back.click()
  await p.locator(`.learn-card[data-opening-id="${id}"]`).click()
  await p.locator(BOARD).waitFor({ timeout: 10000 })
  await p.waitForFunction((want) => document.querySelector('.learn-side-title')?.textContent?.length > 0 && want, id)
}
async function setPracticeOption(cls, on, p = page) {
  await p.locator('[data-testid="learn-practice-options"]').click()
  const input = p.locator(`.${cls} input`)
  if ((await input.isChecked()) !== on) await p.locator(`.${cls}`).click()
  assert((await input.isChecked()) === on, `${cls} not ${on}`)
  await p.keyboard.press('Escape')
}
/** The row of a node in the coach card. */
const rowOf = (nodeId, p = page) => p.locator(`${ROW}[data-node-id="${nodeId}"]`)
async function waitCoachText(nodeId, timeout = 90000, p = page) {
  await p.waitForFunction(
    (id) => {
      const row = [...document.querySelectorAll('[data-testid="learn-coach-row"]')].find((r) => r.getAttribute('data-node-id') === id)
      return row?.getAttribute('data-text') === 'done' || row?.getAttribute('data-text') === 'error'
    },
    nodeId,
    { timeout },
  )
  const row = rowOf(nodeId, p)
  const state = await row.getAttribute('data-text')
  const text = state === 'done' ? await row.locator('[data-testid="learn-coach-text"]').innerText() : await row.innerText()
  return { state, text: text.trim() }
}
async function noReplyFor(ms, expectedFen, p = page) {
  await sleep(ms)
  const fen = await fenOf(p)
  assert(board4(fen) === board4(expectedFen), `position changed to ${fen}`)
}

// ---------------------------------------------------------------- data + setup
const health = await api('/api/health')
const italian = await api('/api/openings/italian-game')
const caro = await api('/api/openings/caro-kann')
const morra = await api('/api/openings/smith-morra-gambit')
console.log(`backend: ${health.stockfish?.name}, ollama ${health.ollama?.ok ? 'up' : 'DOWN'} (${(health.ollama?.models ?? []).length} models)`)
if (!health.ollama?.models?.includes(FAST_MODEL)) console.log(`WARNING: ${FAST_MODEL} is not installed; explanation checks will fail`)

await page.goto(BASE)
await page.evaluate((model) => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('settings-v1', JSON.stringify({ sound: true, coordinates: true, ollamaModel: model, defaultDepth: 16 }))
  // an entry of the old cache (keyed by node only): must be dropped, never shown
  localStorage.setItem('learn-coach-v1', JSON.stringify({ v: 1, e: { 'italian-game|llama3.2:3b|e4': { m: {}, x: 'stale', t: 1 } } }))
}, FAST_MODEL)
await page.reload()
await page.locator('.learn-card').first().waitFor({ timeout: 10000 })

// ---------------------------------------------------------------- (a) Italian as White
const N = (id) => findNode(italian.tree, id)
await check('(a) Italian: 1.e4 on the board -> 1...e5 is played automatically within 2 s', async () => {
  await openOpening('italian-game')
  assert((await page.locator(BOARD).getAttribute('data-orientation')) === 'white', 'orientation')
  await play('e2e4')
  await waitFen(N('e4').fen, 1000)
  const ms = await waitFen(N('e4 e5').fen, 2000)
  return `reply after ~${ms} ms`
})
await check('(a) Italian: 2.Nf3 -> 2...Nc6; 3.Bc4 -> a reply from the line', async () => {
  await play('g1f3')
  await waitFen(N('e4 e5 Nf3 Nc6').fen, 2500)
  await play('f1c4')
  await waitFen(N('e4 e5 Nf3 Nc6 Bc4').fen, 1000)
  const lineId = await belowAttr('data-line-id')
  const line = italian.lines.find((l) => l.id === lineId)
  assert(line, `followed line ${lineId}`)
  await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute('data-ply')) === 6, BELOW, { timeout: 2500 })
  const nodeId = await belowAttr('data-node-id')
  assert(nodeId === line.sans.slice(0, 6).join(' '), `reply ${nodeId} is not the followed line's move (${line.sans[5]})`)
  const reply = N(nodeId)
  assert(board4(await fenOf()) === board4(reply.fen), 'board fen != reply node fen')
  return `3...${reply.san} (line "${line.name}")`
})
await check('(a) coach card: Book badges, engine eval, book why and a streamed explanation', async () => {
  const studentId = 'e4 e5 Nf3 Nc6 Bc4'
  const replyId = await belowAttr('data-node-id')
  const rows = await page.locator(ROW).evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')))
  assert(JSON.stringify(rows) === JSON.stringify([studentId, replyId]), `rows ${JSON.stringify(rows)}`)
  for (const id of rows) assert((await rowOf(id).getAttribute('data-classification')) === 'book', `${id} badge`)
  await page.locator(`${ROW}[data-node-id="${studentId}"] .cls-badge`).waitFor()
  const why = await rowOf(studentId).locator('.learn-coach-why').innerText()
  assert(why.includes(N(studentId).why.slice(0, 40)), 'book why of 3.Bc4')
  await rowOf(studentId).locator('[data-testid="learn-coach-eval"]').waitFor({ timeout: 15000 })
  const evalText = await rowOf(studentId).locator('[data-testid="learn-coach-eval"]').innerText()
  assert(/^[+-]?\d+\.\d$|^-?M\d+$|^#$|^0\.0$/.test(evalText.trim()), `eval "${evalText}"`)
  const tokens0 = wsRecv.filter((m) => m.type === 'token').length
  const { state, text } = await waitCoachText(studentId)
  assert(state === 'done', `coach state ${state}: ${text.slice(0, 120)}`)
  assert(text.length > 40, `short explanation: ${text}`)
  const replyText = await waitCoachText(replyId)
  assert(replyText.state === 'done' && replyText.text.length > 40, `reply explanation ${replyText.state}`)
  const tokens = wsRecv.filter((m) => m.type === 'token').length
  assert(tokens > 5 || tokens0 > 5, `only ${tokens} streamed tokens`)
  const reqs = wsSent.filter((m) => m.uci)
  assert(reqs.every((r) => r.model === FAST_MODEL && r.context?.studentSide === 'white'), 'requests carry model + studentSide')
  const replyReq = reqs.find((r) => r.uci === N(replyId).uci && r.fen === N(studentId).fen)
  assert(replyReq && Array.isArray(replyReq.context.replyBookMoves) && replyReq.context.replyBookMoves.length > 0, 'opponent request has replyBookMoves')
  await shot('01-italian-pair')
  return `eval ${evalText}; ${tokens} tokens; 3.Bc4: "${text.slice(0, 90)}..." | reply: "${replyText.text.slice(0, 70)}..."`
})
await check('(a) every practice move got an engine verdict (and an explanation request)', async () => {
  const ids = ['e4', 'e4 e5', 'e4 e5 Nf3', 'e4 e5 Nf3 Nc6']
  const ucis = ids.map((id) => N(id).uci)
  for (const u of ucis) assert(wsSent.some((m) => m.uci === u), `no coach request for ${u}`)
  const analysed = wsRecv.filter((m) => m.type === 'analysis').map((m) => m.move.uci)
  for (const u of ucis) assert(analysed.includes(u), `no verdict for ${u}`)
  return `${wsSent.length} requests, ${analysed.length} verdicts on ${coachSockets} socket(s)`
})
await check('revisiting a move uses the cache (no new coach request)', async () => {
  const before = wsSent.length
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('ArrowLeft') // to 3.Bc4 (student move): browsing
  await page.keyboard.press('ArrowRight') // back to the reply
  await sleep(600)
  const after = wsSent.length
  assert(after === before, `${after - before} new requests`)
  const txt = await rowOf('e4 e5 Nf3 Nc6 Bc4').getAttribute('data-text')
  assert(txt === 'done', `cached text state ${txt}`)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('learn-coach-v2') ?? '{}'))
  const n = Object.keys(stored.m ?? {}).length
  const x = Object.keys(stored.x ?? {}).length
  assert(n >= 4, `localStorage cache has ${n} verdicts`)
  assert(x >= 2, `localStorage cache has ${x} explanations`)
  // verdicts are per node for every model; explanations per model + line variant
  assert(Object.keys(stored.m).every((k) => k.split('|').length === 2), `verdict keys ${Object.keys(stored.m).slice(0, 2)}`)
  assert(Object.keys(stored.x).every((k) => k.includes(`|${FAST_MODEL}|`)), `explanation keys ${Object.keys(stored.x).slice(0, 2)}`)
  const v1 = await page.evaluate(() => localStorage.getItem('learn-coach-v1'))
  assert(v1 === null, 'the old learn-coach-v1 cache (keyed by node only) was not dropped')
  return `${n} verdicts + ${x} explanations in localStorage; old v1 cache dropped`
})
await check('browsing does not trigger replies; "Play opponent\'s move" + Space', async () => {
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight') // 1.e4 (student moved, opponent to move)
  await noReplyFor(1200, N('e4').fen)
  const btn = page.locator('[data-testid="learn-play-opponent"]')
  await btn.waitFor({ timeout: 2000 })
  await page.keyboard.press('Space')
  await waitFen(N('e4 e5').fen, 1500)
  assert((await btn.count()) === 0, 'button still shown after the reply')
  // the same through the button
  await page.keyboard.press('ArrowLeft')
  await btn.click()
  await waitFen(N('e4 e5').fen, 1500)
  return 'Space and the button both played 1...e5'
})

// ---------------------------------------------------------------- (b) off-book
await check('(b) off-book 1.a4 stays on the board with a verdict, arrow and explanation', async () => {
  await page.keyboard.press('Home')
  await sleep(300)
  await play('a2a4')
  const fenA4 = 'rnbqkbnr/pppppppp/8/8/P7/8/1PPPPPPP/RNBQKBNR b KQkq'
  await waitFen(fenA4, 1500)
  await page.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 2000 })
  await noReplyFor(1200, fenA4) // no reply off book
  const row = page.locator(`${ROW}.offbook`)
  await page.waitForFunction((sel) => !!document.querySelector(sel)?.getAttribute('data-classification'), `${ROW}.offbook`, { timeout: 15000 })
  const cls = await row.getAttribute('data-classification')
  const verdict = await page.locator('[data-testid="learn-offbook-verdict"]').innerText()
  assert(cls && cls !== 'book', `classification ${cls}`)
  await sleep(450) // chessground draws shapes at the end of the move animation
  // chessground always renders one empty wrapper <g>; each shape is a <g> inside it
  const arrows = await page.locator(`${BOARD} svg.cg-shapes g > g`).count()
  assert(arrows >= 1, 'no repertoire arrow drawn')
  const rep = await page.locator('.learn-offbook-rep').innerText()
  assert(rep.includes('1.e4'), `repertoire move: ${rep}`)
  const nodeId = await row.getAttribute('data-node-id')
  const { state, text } = await waitCoachText(nodeId)
  assert(state === 'done' && text.length > 30, `explanation ${state}: ${text.slice(0, 80)}`)
  const req = wsSent.find((m) => m.uci === 'a2a4')
  assert(req && req.context.bookMoves[0]?.san === 'e4', 'request compares with 1.e4')
  await shot('02-offbook-a4')
  return `${cls}: "${verdict}" / "${text.slice(0, 80)}..."`
})
await check('(b) Take back restores the position; Left arrow / Backspace take back too', async () => {
  await page.locator('[data-testid="learn-takeback"]').click()
  await waitFen(italian.tree.fen, 1000)
  assert((await page.locator('[data-testid="learn-offbook"]').count()) === 0, 'off-book block still shown')
  assert((await belowAttr('data-ply')) === '0', 'ply changed')
  await play('h2h4')
  await page.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 2000 })
  await page.keyboard.press('ArrowLeft')
  await waitFen(italian.tree.fen, 1000)
  assert((await belowAttr('data-ply')) === '0', 'left arrow went past the start')
  await play('h2h3')
  await page.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 2000 })
  await page.keyboard.press('Backspace')
  await waitFen(italian.tree.fen, 1000)
  return 'button, Left arrow and Backspace'
})
await check('(b) a sound off-book move says so ("Good move, but not in this repertoire")', async () => {
  // 1.e4 e5 2.Nc3 is a perfectly good move, not in this Italian repertoire
  await play('e2e4')
  await waitFen(N('e4 e5').fen, 2500)
  const node = N('e4 e5')
  if (node.children.some((c) => c.san === 'Nc3')) return 'skipped: 2.Nc3 is in the repertoire'
  await play('b1c3')
  await page.waitForFunction((sel) => !!document.querySelector(sel)?.getAttribute('data-classification'), `${ROW}.offbook`, { timeout: 15000 })
  const cls = await page.locator(`${ROW}.offbook`).getAttribute('data-classification')
  const verdict = await page.locator('[data-testid="learn-offbook-verdict"]').innerText()
  const sound = ['best', 'excellent', 'good', 'great', 'brilliant'].includes(cls)
  assert(!sound || verdict.includes('Good move, but not in this repertoire'), `verdict "${verdict}" for ${cls}`)
  await shot('03-offbook-sound')
  await page.locator('[data-testid="learn-takeback"]').click()
  await waitFen(node.fen, 1000)
  return `2.Nc3 = ${cls}: "${verdict}"`
})

// ---------------------------------------------------------------- (d) navigation cancels a pending reply
await check('(d) Left arrow while a reply is pending: no reply lands on the new position', async () => {
  const at = N('e4 e5')
  assert(board4(await fenOf()) === board4(at.fen), 'not at 1...e5')
  await play('g1f3')
  await page.locator('[data-testid="learn-reply-pending"]').waitFor({ timeout: 500 })
  await page.keyboard.press('ArrowLeft') // back to 1...e5 before the 600 ms reply
  await waitFen(at.fen, 500)
  await noReplyFor(1500, at.fen)
  return 'position stayed at 1...e5'
})
await check('(d) tree click while a reply is pending also cancels it', async () => {
  await play('g1f3')
  await page.locator(`.learn-tree-move[data-node-id="e4"]`).first().click()
  await waitFen(N('e4').fen, 600)
  await noReplyFor(1300, N('e4').fen)
})

// ---------------------------------------------------------------- (e) auto-reply off
await check('(e) Auto-reply OFF: no reply, both sides movable; setting persisted', async () => {
  await page.keyboard.press('Home')
  await setPracticeOption('learn-opt-autoreply', false)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('learn-practice-v1') ?? '{}'))
  assert(stored.autoReply === false, `stored ${JSON.stringify(stored)}`)
  await play('e2e4')
  await waitFen(N('e4').fen, 1000)
  await noReplyFor(1500, N('e4').fen)
  assert((await page.locator('[data-testid="learn-play-opponent"]').count()) === 0, 'play-opponent button shown with auto-reply off')
  await play('e7e5') // the student may move the opponent's pieces too
  await waitFen(N('e4 e5').fen, 1000)
  await shot('04-autoreply-off')
  await setPracticeOption('learn-opt-autoreply', true)
  return 'no reply in 1.5 s; 1...e5 played by hand'
})

// ---------------------------------------------------------------- explain off: verdicts only
await check('coach toggle OFF: engine verdicts are still fetched (explain:false), "Ask the coach" explains', async () => {
  await setPracticeOption('learn-opt-explain', false)
  // a move not played yet in this check: the followed line's 4th White move after 3...Bc5
  const at = 'e4 e5 Nf3 Nc6 Bc4 Bc5'
  await page.locator(`.learn-tree-move[data-node-id="${at}"]`).first().click()
  await waitFen(N(at).fen, 1000)
  const lineId = await belowAttr('data-line-id')
  const line = italian.lines.find((l) => l.id === lineId)
  assert(line && line.sans.length > 6, `followed line ${lineId}`)
  const child = N(line.sans.slice(0, 7).join(' '))
  const before = wsSent.length
  await play(child.uci)
  await waitFen(child.fen, 1000)
  await rowOf(child.id).locator('[data-testid="learn-coach-eval"]').waitFor({ timeout: 15000 })
  const sent = wsSent.slice(before).filter((m) => m.uci === child.uci)
  assert(sent.length > 0 && sent.every((m) => m.explain === false), `requests for ${child.san}: ${JSON.stringify(sent.map((m) => m.explain))}`)
  assert((await rowOf(child.id).getAttribute('data-text')) === 'idle', 'text requested although auto-explain is off')
  await rowOf(child.id).locator('[data-testid="learn-ask-coach"]').click()
  const { state, text } = await waitCoachText(child.id)
  assert(state === 'done' && text.length > 30, `asked explanation ${state}`)
  await setPracticeOption('learn-opt-explain', true)
  return `${child.san}: verdict only, then asked: "${text.slice(0, 70)}..."`
})

// ---------------------------------------------------------------- (c) Caro-Kann as Black
const C = (id) => findNode(caro.tree, id)
await check('(c) Caro-Kann: "Practice" plays White\'s 1.e4 automatically; 1...c6 -> White replies', async () => {
  await openOpening('caro-kann')
  assert((await page.locator(BOARD).getAttribute('data-orientation')) === 'black', 'orientation')
  await page.locator('.learn-practice-btn').click()
  await waitFen(caro.tree.fen, 500)
  const ms = await waitFen(C('e4').fen, 2000)
  await play('c7c6')
  await waitFen(C('e4 c6').fen, 1000)
  await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute('data-ply')) === 3, BELOW, { timeout: 2500 })
  const id = await belowAttr('data-node-id')
  const lineId = await belowAttr('data-line-id')
  const line = caro.lines.find((l) => l.id === lineId)
  assert(line && line.sans.slice(0, 3).join(' ') === id, `reply ${id} not on the followed line ${lineId}`)
  const reqs = wsSent.filter((m) => m.context?.studentSide === 'black')
  assert(reqs.length >= 2, 'coach requests with studentSide black')
  await shot('05-caro-black')
  return `1.e4 after ~${ms} ms, then 2.${C(id).san} (${line.name})`
})
await check('(c) Random variation: the reply is a tree move, the followed line switches to it', async () => {
  await page.locator('[data-testid="learn-practice-options"]').click()
  await page.locator('.learn-opt-replymode select').selectOption('random')
  await page.keyboard.press('Escape')
  const seen = new Set()
  for (let i = 0; i < 8; i++) {
    await page.locator('.learn-practice-btn').click()
    await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute('data-ply')) === 1, BELOW, { timeout: 2500 })
    await play('c7c6')
    await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute('data-ply')) === 3, BELOW, { timeout: 2500 })
    const id = await belowAttr('data-node-id')
    const node = C(id)
    assert(node && id.startsWith('e4 c6 '), `random reply ${id} not in the tree`)
    const lineId = await belowAttr('data-line-id')
    const line = caro.lines.find((l) => l.id === lineId)
    assert(line && line.sans.slice(0, 3).join(' ') === id, `followed line ${lineId} does not go through ${id}`)
    seen.add(node.san)
  }
  await page.locator('[data-testid="learn-practice-options"]').click()
  await page.locator('.learn-opt-replymode select').selectOption('line')
  await page.keyboard.press('Escape')
  return `replies seen: ${[...seen].join(', ')}`
})

// ---------------------------------------------------------------- (f) line complete
await check('(f) Smith-Morra short line: "Line complete" with moves and off-book attempts; Practice again; Next line', async () => {
  await openOpening('smith-morra-gambit')
  const line = morra.lines.find((l) => l.id === 'sl-2d6') ?? [...morra.lines].sort((a, b) => a.sans.length - b.sans.length)[0]
  await page.locator('.learn-side .panel-tabs button', { hasText: 'Lines' }).click()
  await page.locator(`.learn-line[data-line-id="${line.id}"] .learn-line-head`).click()
  await page.locator('.learn-practice-btn').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW)
  assert((await belowAttr('data-line-id')) === line.id, 'line not followed')
  const nodes = []
  let n = morra.tree
  for (const s of line.sans) {
    n = n.children.find((c) => c.san === s)
    nodes.push(n)
  }
  let offBookTried = false
  let studentMoves = 0
  for (let i = 0; i < nodes.length; i += 2) {
    if (i === 2 && !offBookTried) {
      // one off-book attempt (2.Nf3 is not in this repertoire), then take it back
      offBookTried = true
      if (!nodes[1].children.some((c) => c.san === 'Nf3')) {
        await play('g1f3')
        await page.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 2000 })
        await page.locator('[data-testid="learn-takeback"]').click()
        await waitFen(nodes[1].fen, 1000)
      }
    }
    await play(nodes[i].uci)
    studentMoves += 1
    await waitFen(nodes[i].fen, 1000)
    if (nodes[i + 1]) await waitFen(nodes[i + 1].fen, 2500)
  }
  const card = page.locator('[data-testid="learn-complete"]')
  await card.waitFor({ timeout: 3000 })
  const moves = Number((await page.locator('[data-testid="learn-complete-moves"] b').innerText()).trim())
  const off = Number((await page.locator('[data-testid="learn-complete-offbook"] b').innerText()).trim())
  assert(moves === studentMoves, `moves played ${moves}, expected ${studentMoves}`)
  assert(off === 1, `off-book attempts ${off}`)
  await shot('06-line-complete')
  await page.locator('[data-testid="learn-practice-again"]').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW, { timeout: 1500 })
  assert((await belowAttr('data-line-id')) === line.id, 'practice again changed the line')
  assert((await card.count()) === 0, 'complete card still shown')
  // finish it once more quickly to reach the card, then Next line
  for (let i = 0; i < nodes.length; i += 2) {
    await play(nodes[i].uci)
    await waitFen(nodes[i].fen, 1000)
    if (nodes[i + 1]) await waitFen(nodes[i + 1].fen, 2500)
  }
  await card.waitFor({ timeout: 3000 })
  await page.locator('[data-testid="learn-next-line"]').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW, { timeout: 1500 })
  const next = await belowAttr('data-line-id')
  const nextLine = morra.lines.find((l) => l.id === next)
  assert(next && next !== line.id, `next line ${next}`)
  return `${line.name}: ${moves} moves, ${off} off-book; next line: ${nextLine?.name} (${nextLine?.category})`
})

// ---------------------------------------------------------------- fix-pass regressions
const lineHead = (id, p = page) => p.locator(`.learn-line[data-line-id="${id}"] .learn-line-head`)
async function practiseLine(lineId, p = page) {
  await p.locator('.learn-side .panel-tabs button', { hasText: 'Lines' }).click()
  await lineHead(lineId, p).click()
  await p.locator('.learn-practice-btn').click()
  await p.waitForFunction(([sel, id]) => {
    const el = document.querySelector(sel)
    return el?.getAttribute('data-ply') === '0' && el?.getAttribute('data-line-id') === id
  }, [BELOW, lineId])
}
async function arrowCount(p = page) {
  await sleep(450) // chessground redraws shapes at the end of the move animation
  return p.locator(`${BOARD} svg.cg-shapes g > g`).count() // one <g> per shape inside the wrapper <g>
}
const offBookRow = (p = page) => p.locator(`${ROW}.offbook`)
async function playOffBook(uci, p = page) {
  await play(uci, p)
  await p.locator('[data-testid="learn-offbook"]').waitFor({ timeout: 2000 })
  return offBookRow(p).getAttribute('data-node-id')
}
const explainReqs = (from, uci) => wsSent.slice(from).filter((m) => m.uci === uci && m.explain === true)
async function textState(nodeId, p = page) {
  return (await rowOf(nodeId, p).getAttribute('data-text')) ?? 'missing'
}
async function openSettingsModel(model, p = page) {
  await p.locator('button[title="Settings"]').click()
  const sel = p.locator('[role="dialog"] select').first()
  await sel.selectOption(model)
  await p.keyboard.press('Escape')
  await p.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 2000 })
}

const BC5 = 'e4 e5 Nf3 Nc6 Bc4 Bc5'
async function italianToBc5() {
  await play('e2e4')
  await waitFen(N('e4 e5').fen, 2500)
  await play('g1f3')
  await waitFen(N('e4 e5 Nf3 Nc6').fen, 2500)
  await play('f1c4')
  await waitFen(N(BC5).fen, 2500)
}

await check('fix: the coach cache follows the line (opponent advice and off-book comparison are not reused across lines)', async () => {
  await openOpening('italian-game')
  const A = 'giuoco-piano-7bd2'
  const B = 'evans-gambit-ba5-exd4'
  assert(italian.lines.some((l) => l.id === A) && italian.lines.some((l) => l.id === B), 'line ids changed')
  await practiseLine(A)
  let from = wsSent.length
  await italianToBc5()
  await waitCoachText(BC5)
  const reqA = explainReqs(from, 'f8c5')
  assert(reqA.length <= 1, `${reqA.length} requests for 3...Bc5 on line A`)
  const replyA = reqA[0]?.context?.replyBookMoves?.[0]?.san ?? '(cached)'
  from = wsSent.length
  const offA = await playOffBook('h2h3')
  await waitCoachText(offA)
  const hA = explainReqs(from, 'h2h3')
  assert(hA.length === 1 && hA[0].context.bookMoves[0].san === 'c3', `4.h3 on line A compared with ${hA[0]?.context?.bookMoves?.[0]?.san}`)
  await page.locator('[data-testid="learn-takeback"]').click()
  // the Evans Gambit line: 3...Bc5 must be explained again, recommending 4.b4
  await practiseLine(B)
  from = wsSent.length
  await italianToBc5()
  const textB = await waitCoachText(BC5)
  const reqB = explainReqs(from, 'f8c5')
  assert(reqB.length === 1, `${reqB.length} new requests for 3...Bc5 on line B (cached text of line A reused)`)
  assert(reqB[0].context.replyBookMoves[0].san === 'b4', `line B recommends ${reqB[0].context.replyBookMoves[0].san}`)
  from = wsSent.length
  const offB = await playOffBook('h2h3')
  assert(offB === offA, 'off-book ids differ')
  const offText = await waitCoachText(offB)
  const hB = explainReqs(from, 'h2h3')
  assert(hB.length === 1 && hB[0].context.bookMoves[0].san === 'b4', `4.h3 on line B: ${hB.length} requests, compared with ${hB[0]?.context?.bookMoves?.[0]?.san}`)
  const rep = await page.locator('.learn-offbook-rep').innerText()
  assert(rep.includes('4.b4'), `card repertoire move: ${rep}`)
  await shot('12-cache-per-line')
  return `line A reply ${replyA}; line B 3...Bc5 re-asked (b4): "${textB.text.slice(0, 60)}..."; 4.h3 vs b4: "${offText.text.slice(0, 60)}..."`
})

await check('fix: changing the coach model keeps the verdicts and asks the new model (off-book card never spins forever)', async () => {
  // still at 3...Bc5 with the off-book 4.h3 of the previous check on the board
  const other = (health.ollama?.models ?? []).find((m) => m === 'qwen2.5:1.5b') ?? (health.ollama?.models ?? []).find((m) => m !== FAST_MODEL && !m.startsWith('gpt-oss'))
  if (!other) return 'skipped: only one fast model installed'
  const id = await offBookRow().getAttribute('data-node-id')
  const before = await page.locator('[data-testid="learn-offbook-verdict"]').innerText()
  const from = wsSent.length
  await openSettingsModel(other)
  await sleep(300)
  const verdictState = await offBookRow().getAttribute('data-verdict')
  const after = await page.locator('[data-testid="learn-offbook-verdict"]').innerText()
  assert(verdictState === 'done', `verdict state after the switch: ${verdictState}`)
  assert(!/Checking it with the engine/.test(after), `verdict now: ${after}`)
  assert((await offBookRow().locator('[data-testid="learn-coach-eval"]').count()) === 1, 'eval disappeared')
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && !wsSent.slice(from).some((m) => m.uci === 'h2h3' && m.model === other && m.explain)) await sleep(100)
  assert(wsSent.slice(from).some((m) => m.uci === 'h2h3' && m.model === other && m.explain), `no request to ${other} after the switch`)
  const t = await waitCoachText(id, 90000)
  assert(t.state === 'done', `explanation with ${other}: ${t.state}`)
  await openSettingsModel(FAST_MODEL)
  await page.locator('[data-testid="learn-takeback"]').click()
  return `${before} -> ${after}; ${other}: "${t.text.slice(0, 60)}..."`
})

await check('fix: Escape closes the Practice options menu and keeps the off-book move', async () => {
  await waitFen(N(BC5).fen, 1000)
  const fenH3 = (await playOffBook('h2h3')) && (await fenOf())
  await page.locator('[data-testid="learn-practice-options"]').click()
  await page.locator('[data-testid="learn-practice-pop"]').waitFor({ timeout: 1000 })
  await page.keyboard.press('Escape')
  await sleep(200)
  assert((await page.locator('[data-testid="learn-practice-pop"]').count()) === 0, 'menu still open')
  assert((await page.locator('[data-testid="learn-offbook"]').count()) === 1, 'Escape also took back the off-book move')
  assert(board4(await fenOf()) === board4(fenH3), 'board changed')
  await page.keyboard.press('Escape') // menu closed: now Escape takes the move back
  await waitFen(N(BC5).fen, 1000)
  return 'menu closed, 4.h3 kept; a second Escape took it back'
})

await check('fix: "Previous move" with an off-book move on the board takes it back (like Left)', async () => {
  await playOffBook('h2h3')
  await page.locator('.learn-controls button[title="Previous move (Left arrow)"]').click()
  await waitFen(N(BC5).fen, 1000)
  assert((await belowAttr('data-ply')) === '6', `ply ${await belowAttr('data-ply')}`)
  assert((await page.locator('[data-testid="learn-offbook"]').count()) === 0, 'off-book card still shown')
  return 'back at 3...Bc5 (ply 6)'
})

await check('fix: practising hides the answer arrows on your turn; the arrows button shows a hint; browsing shows them', async () => {
  await practiseLine('giuoco-piano-7bd2')
  assert((await belowAttr('data-practising')) === 'true', 'not practising after Practice')
  const hidden = await arrowCount()
  assert(hidden === 0, `${hidden} arrows on the student's turn while practising`)
  await page.locator('[data-testid="learn-arrows-toggle"]').click()
  const hint = await arrowCount()
  assert(hint >= 1, 'the hint did not show the arrows')
  await play('e2e4')
  await waitFen(N('e4 e5').fen, 2500)
  const hiddenAgain = await arrowCount()
  assert(hiddenAgain === 0, `${hiddenAgain} arrows after the reply (the hint is for one position)`)
  await page.keyboard.press('ArrowLeft') // browsing
  await page.keyboard.press('ArrowLeft')
  await waitFen(italian.tree.fen, 1000)
  assert((await belowAttr('data-practising')) === 'false', 'still practising after browsing')
  const browsing = await arrowCount()
  assert(browsing >= 1, 'no arrows while browsing')
  return `practising: ${hidden}, hint: ${hint}, browsing: ${browsing} arrow(s)`
})

await check('fix: with Auto-reply off, "Line complete" counts every student move', async () => {
  await openOpening('smith-morra-gambit')
  const line = morra.lines.find((l) => l.id === 'sl-2d6')
  assert(line, 'line sl-2d6 missing')
  await setPracticeOption('learn-opt-autoreply', false)
  try {
    await practiseLine(line.id)
    let n = morra.tree
    for (const s of line.sans) {
      n = n.children.find((c) => c.san === s)
      await play(n.uci)
      await waitFen(n.fen, 1000)
    }
    await page.locator('[data-testid="learn-complete"]').waitFor({ timeout: 3000 })
    const moves = Number((await page.locator('[data-testid="learn-complete-moves"] b').innerText()).trim())
    const want = Math.ceil(line.sans.length / 2)
    assert(moves === want, `"${moves} moves played", expected ${want}`)
    return `${moves} moves played (all ${line.sans.length} plies by hand)`
  } finally {
    await setPracticeOption('learn-opt-autoreply', true)
  }
})

await check('fix: Left while the pair is being explained neither restarts nor re-asks the coach', async () => {
  await openOpening('london-system')
  await page.locator('.learn-practice-btn').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW)
  const london = await api('/api/openings/london-system')
  const lineId = await belowAttr('data-line-id')
  const line = london.lines.find((l) => l.id === lineId)
  const n1 = london.tree.children.find((c) => c.san === line.sans[0])
  const n2 = n1.children.find((c) => c.san === line.sans[1])
  const from = wsSent.length
  const sockets0 = coachSockets
  await play(n1.uci)
  await waitFen(n2.fen, 2500)
  const states = [await textState(n1.id), await textState(n2.id)]
  await page.keyboard.press('ArrowLeft')
  await sleep(400)
  const meaningful = states.some((s) => s === 'queued' || s === 'streaming')
  const afterLeft = await textState(n1.id)
  // the view was just opened: one new socket for its first request; a restart would open another
  const opened = coachSockets - sockets0
  assert(opened <= 1, `${opened} sockets opened (the coach was restarted)`)
  assert(explainReqs(from, n1.uci).length === 1, `${explainReqs(from, n1.uci).length} explanation requests for ${n1.san}`)
  if (states[0] === 'streaming') assert(afterLeft === 'streaming' || afterLeft === 'done', `${n1.san} text went ${states[0]} -> ${afterLeft}`)
  await page.keyboard.press('ArrowRight')
  const t = await waitCoachText(n2.id)
  assert(t.state === 'done', `reply explanation ${t.state}`)
  assert(explainReqs(from, n2.uci).length === 1, `${explainReqs(from, n2.uci).length} explanation requests for ${n2.san}`)
  return `${meaningful ? '' : '(explanations were already done before Left) '}states before Left ${states.join('/')}, after: ${afterLeft}; 1 request each`
})

await check("fix: the opponent's reply is still explained after you move on quickly", async () => {
  await openOpening('vienna-gambit')
  await page.locator('.learn-practice-btn').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW)
  const vienna = await api('/api/openings/vienna-gambit')
  const viennaLineId = await belowAttr('data-line-id')
  const line = vienna.lines.find((l) => l.id === viennaLineId)
  const nodes = []
  let n = vienna.tree
  for (const s of line.sans.slice(0, 4)) {
    n = n.children.find((c) => c.san === s)
    nodes.push(n)
  }
  const from = wsSent.length
  await play(nodes[0].uci)
  await waitFen(nodes[1].fen, 2500)
  const replyState = await textState(nodes[1].id)
  await play(nodes[2].uci) // move on at once
  await waitFen(nodes[3].fen, 2500)
  // the left pair's reply keeps its place in the queue and is explained without a new request
  const t0 = Date.now()
  const doneFor = (id) => wsRecv.some((m) => m.type === 'done' && m.requestId === id && m.text)
  const replyReq = explainReqs(from, nodes[1].uci)[0]
  assert(replyReq, `no explanation request for ${nodes[1].san}`)
  while (Date.now() - t0 < 90000 && !doneFor(replyReq.requestId)) await sleep(200)
  assert(doneFor(replyReq.requestId), `${nodes[1].san} was never explained`)
  assert(explainReqs(from, nodes[1].uci).length === 1, `${explainReqs(from, nodes[1].uci).length} requests for ${nodes[1].san}`)
  const t = await waitCoachText(nodes[2].id)
  assert(t.state === 'done', `${nodes[2].san}: ${t.state}`)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await waitFen(nodes[1].fen, 1000)
  assert((await textState(nodes[1].id)) === 'done', `going back: ${nodes[1].san} text ${await textState(nodes[1].id)}`)
  return `${nodes[1].san} was "${replyState}" when the student moved on; explained without a second request`
})

await check('fix: quick play two pairs ahead: older explanations make way, and resume when you go back', async () => {
  await openOpening('scotch-gambit')
  await page.locator('.learn-practice-btn').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW)
  const sg = await api('/api/openings/scotch-gambit')
  const sgLineId = await belowAttr('data-line-id')
  const line = sg.lines.find((l) => l.id === sgLineId)
  const nodes = []
  let n = sg.tree
  for (const s of line.sans.slice(0, 6)) {
    n = n.children.find((c) => c.san === s)
    nodes.push(n)
  }
  const from = wsSent.length
  const sockets0 = coachSockets
  for (let i = 0; i < 6; i += 2) {
    await play(nodes[i].uci)
    await waitFen(nodes[i + 1].fen, 2500) // the reply landed: move on at once
  }
  const t = await waitCoachText(nodes[4].id)
  assert(t.state === 'done', `${nodes[4].san}: ${t.state}`)
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
  await waitFen(nodes[1].fen, 1000)
  const a = await waitCoachText(nodes[0].id)
  const b = await waitCoachText(nodes[1].id)
  assert(a.state === 'done' && b.state === 'done', `going back: ${nodes[0].san} ${a.state}, ${nodes[1].san} ${b.state}`)
  const reqs = [explainReqs(from, nodes[0].uci).length, explainReqs(from, nodes[1].uci).length]
  const restarts = coachSockets - sockets0 - 1
  return `${restarts} socket replacement(s); first pair explained with ${reqs.join('+')} request(s), no "Ask the coach" needed`
})

await check('fix: after a tab switch mid-practice the reply is played and the coach resumes', async () => {
  await openOpening('queens-gambit')
  await page.locator('.learn-practice-btn').click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ply') === '0', BELOW)
  const qg = await api('/api/openings/queens-gambit')
  const qgLineId = await belowAttr('data-line-id')
  const line = qg.lines.find((l) => l.id === qgLineId)
  const n1 = qg.tree.children.find((c) => c.san === line.sans[0])
  const n2 = n1.children.find((c) => c.san === line.sans[1])
  await play(n1.uci)
  await waitFen(n1.fen, 1000)
  await page.locator('.nav-item', { hasText: 'Quiz' }).click() // within the 600 ms reply delay
  await page.locator('.nav-item', { hasText: 'Learn' }).click()
  await page.locator(BOARD).waitFor({ timeout: 10000 })
  await waitFen(n2.fen, 3000)
  await page.waitForFunction(
    (id) => {
      const row = [...document.querySelectorAll('[data-testid="learn-coach-row"]')].find((r) => r.getAttribute('data-node-id') === id)
      return row?.getAttribute('data-verdict') === 'done' && row?.getAttribute('data-text') !== 'idle'
    },
    n1.id,
    { timeout: 20000 },
  )
  const t = await waitCoachText(n1.id)
  assert(t.state === 'done', `${n1.san}: ${t.state}`)
  return `reply ${n2.san} played after returning; ${n1.san} verdict + explanation resumed`
})

await check('fix: 1366x768 pair: the opponent row below the fold is named by a bar that scrolls to it', async () => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openOpening('budapest-gambit')
  const bud = await api('/api/openings/budapest-gambit')
  const B = (id) => findNode(bud.tree, id)
  await page.locator('.learn-practice-btn').click()
  await waitFen(B('d4').fen, 2500)
  await play('g8f6')
  await waitFen(B('d4 Nf6 c4').fen, 2500)
  await play('e7e5')
  await waitFen(B('d4 Nf6 c4 e5 dxe5').fen, 2500)
  await waitCoachText('d4 Nf6 c4 e5')
  await waitCoachText('d4 Nf6 c4 e5 dxe5')
  const m = await page.evaluate(() => {
    const card = document.querySelector('.learn-coach').getBoundingClientRect()
    const rows = [...document.querySelectorAll('[data-testid="learn-coach-row"]')].map((r) => r.getBoundingClientRect())
    return { cardTop: card.top, cardBottom: card.bottom, cardH: card.height, replyTop: rows[1]?.top ?? 0, n: rows.length }
  })
  assert(m.n === 2, `${m.n} rows`)
  assert(m.cardH >= 180, `card only ${Math.round(m.cardH)} px high`)
  const bar = page.locator('[data-testid="learn-coach-more"]')
  await shot('13-pair-1366')
  if (m.replyTop <= m.cardBottom - 24) {
    assert((await bar.count()) === 0, 'bar shown although the reply row is visible')
    return `reply row visible without scrolling (card ${Math.round(m.cardH)} px)`
  }
  await bar.waitFor({ timeout: 1000 })
  const label = (await bar.innerText()).replace(/\s+/g, ' ')
  assert(label.includes('3.dxe5'), `bar: ${label}`)
  await bar.click()
  await sleep(700)
  const top = await page.evaluate(() => [...document.querySelectorAll('[data-testid="learn-coach-row"]')][1].getBoundingClientRect().top)
  const card = await page.evaluate(() => document.querySelector('.learn-coach').getBoundingClientRect())
  assert(top >= card.top - 1 && top < card.bottom - 40, `reply row at ${Math.round(top)} not inside the card (${Math.round(card.top)}-${Math.round(card.bottom)})`)
  assert((await bar.count()) === 0, 'bar still shown after scrolling')
  await shot('14-pair-1366-scrolled')
  return `card ${Math.round(m.cardH)} px; bar "${label.trim()}" scrolled the reply into view`
})

await check('fix: a repertoire move reached by transposition counts as in book (Budapest ...Qa3)', async () => {
  const bud = await api('/api/openings/budapest-gambit')
  const path = 'd4 Nf6 c4 e5 dxe5 Ng4 Nf3 Nc6 Bf4 Bb4+ Nc3 Bxc3+ bxc3 Qe7 Qd5'
  const target = 'd4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nc3 Bxc3+ bxc3 Qe7 Qd5 Qa3'
  const line = bud.lines.find((l) => l.sans.join(' ').startsWith(path))
  const here = findNode(bud.tree, path)
  if (!line || !here || here.children.some((c) => c.san === 'Qa3') || !findNode(bud.tree, target)) return 'skipped: data changed'
  await page.locator('.learn-side .panel-tabs button', { hasText: 'Lines' }).click()
  await lineHead(line.id).click()
  await page.locator(`.learn-line.active[data-line-id="${line.id}"] .learn-line-move`).nth(14).click()
  await waitFen(here.fen, 2000)
  const from = wsSent.length
  await play('e7a3')
  await waitFen(findNode(bud.tree, target).fen, 1500)
  await sleep(300)
  assert((await page.locator('[data-testid="learn-offbook"]').count()) === 0, '...Qa3 shown as off book')
  assert((await belowAttr('data-node-id')) === target, `node ${await belowAttr('data-node-id')}`)
  const req = wsSent.slice(from).find((m) => m.uci === 'e7a3')
  assert(req && req.context.bookMoves.some((b) => b.san === 'Qa3'), 'request bookMoves miss ...Qa3')
  const t0 = Date.now()
  while (Date.now() - t0 < 15000 && !wsRecv.some((m) => m.type === 'analysis' && m.requestId === req.requestId)) await sleep(100)
  const verdict = wsRecv.find((m) => m.type === 'analysis' && m.requestId === req.requestId)
  assert(verdict?.move?.inBook === true && verdict.move.classification === 'book', `coach verdict ${verdict?.move?.classification}`)
  return '...Qa3 played in book (board on the 4.Bf4 move order), coach: book'
})

// ---------------------------------------------------------------- layout
for (const [w, h] of [
  [1366, 768],
  [1920, 1080],
]) {
  await check(`layout ${w}x${h}: card and controls fit under the board`, async () => {
    await page.setViewportSize({ width: w, height: h })
    await openOpening('italian-game')
    await page.keyboard.press('Home')
    await sleep(200)
    await play('e2e4')
    await waitFen(N('e4 e5').fen, 2500)
    await sleep(500)
    const m = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect()
      const below = r('.learn-below')
      const card = r('.learn-coach')
      const controls = r('.learn-controls')
      const lastBtn = [...document.querySelectorAll('.learn-controls button')].map((b) => b.getBoundingClientRect()).reduce((a, b) => (b.right > a ? b.right : a), 0)
      const boardR = r('.learn-view .board-root')
      return {
        vh: innerHeight,
        vw: innerWidth,
        docW: document.documentElement.scrollWidth,
        belowBottom: below.bottom,
        belowLeft: below.left,
        belowRight: below.right,
        cardH: card.height,
        cardTop: card.top,
        controlsBottom: controls.bottom,
        lastBtn,
        board: Math.round(boardR.width),
      }
    })
    assert(m.controlsBottom <= m.vh + 0.5, `controls off-screen (${m.controlsBottom} > ${m.vh})`)
    assert(m.lastBtn <= m.belowRight + 1, `buttons overflow the column (${m.lastBtn} > ${m.belowRight})`)
    assert(m.docW <= m.vw, 'horizontal overflow')
    assert(m.cardH >= 100, `card only ${m.cardH}px high`)
    await shot(`0${w === 1366 ? 7 : 8}-layout-${w}x${h}`)
    return `board ${m.board}px, card ${Math.round(m.cardH)}px`
  })
}
await page.setViewportSize({ width: 1366, height: 768 })

// ---------------------------------------------------------------- coach failures
await check('Ollama failure (unknown model): engine verdict + "Coach unavailable" note, practice continues', async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings-v1') ?? '{}')
    localStorage.setItem('settings-v1', JSON.stringify({ ...s, ollamaModel: 'no-such-model:0b' }))
  })
  await page.reload()
  await page.locator(BOARD).waitFor({ timeout: 10000 })
  await page.keyboard.press('Home')
  await sleep(200)
  await play('e2e4')
  await waitFen(N('e4 e5').fen, 2500)
  const err = page.locator(`${ROW}[data-node-id="e4"] [data-testid="learn-coach-error"]`)
  await err.waitFor({ timeout: 20000 })
  const msg = await err.innerText()
  assert(/Coach unavailable/.test(msg), `message: ${msg}`)
  await rowOf('e4').locator('[data-testid="learn-coach-eval"]').waitFor({ timeout: 10000 })
  const why = await page.locator(CARD).innerText()
  assert(why.includes(N('e4').why.slice(0, 30)), 'book why missing')
  await shot('09-coach-unavailable')
  await page.evaluate((model) => {
    const s = JSON.parse(localStorage.getItem('settings-v1') ?? '{}')
    localStorage.setItem('settings-v1', JSON.stringify({ ...s, ollamaModel: model }))
  }, FAST_MODEL)
  return msg.replace(/\s+/g, ' ').trim()
})

await check('(g) no console errors', async () => {
  assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))
})

// a second, isolated page where /ws/coach is refused entirely
await check('backend coach unreachable: book why stays, practice still works', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.routeWebSocket(/\/ws\/coach/, (ws) => ws.close({ code: 1011, reason: 'coach down (test)' }))
  await p.goto(BASE)
  await p.evaluate((model) => {
    localStorage.clear()
    localStorage.setItem('settings-v1', JSON.stringify({ sound: false, coordinates: true, ollamaModel: model, defaultDepth: 16 }))
    localStorage.setItem('learn-last-v1', JSON.stringify({ openingId: 'italian-game', nodeId: '', lineId: null }))
  }, FAST_MODEL)
  await p.reload()
  await p.locator(BOARD).waitFor({ timeout: 10000 })
  await play('e2e4', p)
  await waitFen(N('e4 e5').fen, 2500, p)
  await play('g1f3', p)
  await waitFen(N('e4 e5 Nf3 Nc6').fen, 2500, p)
  const text = await p.locator(CARD).innerText()
  assert(text.includes(N('e4 e5 Nf3').why.slice(0, 30)), 'book why missing')
  assert(/unavailable/i.test(text), `no unavailable note: ${text.slice(0, 200)}`)
  assert(errs.length === 0, errs.join(' | '))
  await shot('10-coach-unreachable', p)
  await ctx.close()
  return 'replies kept coming with the coach socket refused'
})

if (process.env.CHECK_GPT_OSS === '1') {
  await check('gpt-oss:20b explains an opponent blunder from the student\'s side', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    const p = await ctx.newPage()
    await p.goto(BASE)
    await p.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('settings-v1', JSON.stringify({ sound: false, coordinates: true, ollamaModel: 'gpt-oss:20b', defaultDepth: 16 }))
      localStorage.setItem('learn-last-v1', JSON.stringify({ openingId: 'italian-game', nodeId: '', lineId: null }))
    })
    await p.reload()
    await p.locator(BOARD).waitFor({ timeout: 10000 })
    // trap line: ...Bh5 6.Nxe5! Bxd1?? 7.Bxf7+ Ke7 8.Nd5# (Legal's mate). Practise 6.Nxe5 and let
    // the opponent fall for it.
    const trap = italian.lines.find((l) => l.id === 'semi-italian-legal-mate') ?? italian.lines.find((l) => l.category === 'trap')
    const k = trap.sans.findIndex((s, i) => i % 2 === 0 && i >= 6 && N(trap.sans.slice(0, i + 2).join(' '))?.nag === '??')
    const at = k > 0 ? k : 10
    await p.locator('.learn-side .panel-tabs button', { hasText: 'Lines' }).click()
    await p.locator(`.learn-line[data-line-id="${trap.id}"] .learn-line-head`).click()
    await p.locator(`.learn-line.active[data-line-id="${trap.id}"] .learn-line-move`).nth(at - 1).click()
    await waitFen(N(trap.sans.slice(0, at).join(' ')).fen, 2000, p)
    const studentId = trap.sans.slice(0, at + 1).join(' ')
    const replyId = trap.sans.slice(0, at + 2).join(' ')
    await play(N(studentId).uci, p)
    await waitFen(N(replyId).fen, 2500, p)
    const a = await waitCoachText(studentId, 240000, p)
    const b = await waitCoachText(replyId, 240000, p)
    const tag = await p.locator(`${ROW}[data-node-id="${replyId}"] .learn-coach-tag`).allInnerTexts()
    await shot('11-gpt-oss-trap', p)
    await ctx.close()
    assert(a.state === 'done' && b.state === 'done', `${a.state}/${b.state}`)
    return `${N(studentId).san}: "${a.text}" || ${N(replyId).san} [${tag.join(',') || 'no engine tag'}]: "${b.text}"`
  })
}

await browser.close()
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
