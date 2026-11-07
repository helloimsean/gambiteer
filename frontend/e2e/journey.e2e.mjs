// End-to-end user journey through all five tabs against the PRODUCTION build served by the backend.
//
//   cd backend  && python -m uvicorn app.main:app --port 8000     (after `npm run build` in frontend/)
//   cd frontend && node e2e/journey.e2e.mjs [baseUrl]              (default http://localhost:8000)
//   or: npm run e2e
//
// Needs Stockfish (engines/stockfish19.exe) and Ollama with the model in $MODEL (default llama3.2:3b).
// Env: MODEL, DEPTH (review depth, default 10), HEADED=1 to watch.
//
// Journey: Learn (open an opening, click 5 tree nodes, read the why) -> Quiz (position quiz: one
// correct answer read from the API and played on the board, one wrong answer) -> Analyze (engine
// toggle, lines reach depth >= 10, play 2 moves) -> Play (white vs 1200, 3 moves + 3 bot replies)
// -> Review (paste PGN, depth 10, accuracy + mistake/blunder badges, Explain streams text).
// Screenshots: frontend/screenshots/e2e-*.png. Any uncaught page exception or console error fails
// the run. Exit code 0 = everything passed.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { Chess } from 'chess.js'

const FRONTEND = fileURLToPath(new URL('../', import.meta.url))
const SHOTS = join(FRONTEND, 'screenshots')
const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const MODEL = process.env.MODEL ?? 'llama3.2:3b'
const DEPTH = process.env.DEPTH ?? '10'
const OPENING_ID = 'alien-gambit'

// A short game with obvious mistakes and a blunder (13...Bb7?? drops a whole rook's worth).
// (The PGN suggested in the task text had an illegal 14...Nd7; this is the same game made legal.)
const REVIEW_PGN = `[Event "E2E blunder game"]
[White "Student"]
[Black "Opponent"]
[Result "*"]

1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5 5.exd5 Nxd5 6.Nxf7 Kxf7 7.Qf3+ Ke6 8.Nc3 Nb4 9.a3 Nxc2+
10.Kd1 Nxa1 11.Nxd5 Kd6 12.d4 b5 13.Bxb5 Bb7 14.Qf7 a6 15.dxe5+ Kc5 16.Be3+ *`
const REVIEW_PLIES = 31

mkdirSync(SHOTS, { recursive: true })

// ---------------------------------------------------------------- tiny test harness
let failed = 0
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
async function check(name, fn) {
  const t0 = Date.now()
  try {
    const d = await fn()
    record(name, true, `${typeof d === 'string' ? `${d}; ` : ''}${((Date.now() - t0) / 1000).toFixed(1)} s`)
    return true
  } catch (err) {
    record(name, false, err instanceof Error ? err.message.split('\n')[0] : String(err))
    await shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`).catch(() => {})
    return false
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: !process.env.HEADED })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page = await context.newPage()

const pageErrors = [] // uncaught exceptions
const consoleErrors = []
const httpErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`)
})
const botResponses = []
page.on('response', async (r) => {
  if (r.url().endsWith('/api/bot/move') && r.ok()) botResponses.push(await r.json().catch(() => null))
})

async function shot(name) {
  await page.screenshot({ path: join(SHOTS, `e2e-${name}.png`) })
}
async function gotoTab(label, readySelector) {
  await page.locator('.nav-item', { hasText: label }).click()
  await page.locator(readySelector).first().waitFor({ timeout: 10000 })
}

// ---------------------------------------------------------------- board helpers (chessground)
function squareCenter(box, sq, orientation) {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  const s = box.width / 8
  const col = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 7 - rank : rank
  return { x: box.x + s * (col + 0.5), y: box.y + s * (row + 0.5) }
}
/** Drag a piece from `from` to `to` on the board inside `root` (a `.board-root` selector). */
async function drag(root, from, to) {
  const board = page.locator(`${root} cg-board`)
  const box = await board.boundingBox()
  assert(box, `no board at ${root}`)
  const o = (await page.locator(root).getAttribute('data-orientation')) ?? 'white'
  const a = squareCenter(box, from, o)
  const b = squareCenter(box, to, o)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 })
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.mouse.up()
  await sleep(150)
}
/** Click-click move (select the piece, then click the destination square). */
async function clickMove(root, from, to) {
  const box = await page.locator(`${root} cg-board`).boundingBox()
  assert(box, `no board at ${root}`)
  const o = (await page.locator(root).getAttribute('data-orientation')) ?? 'white'
  const a = squareCenter(box, from, o)
  const b = squareCenter(box, to, o)
  await page.mouse.click(a.x, a.y)
  await sleep(80)
  await page.mouse.click(b.x, b.y)
  await sleep(150)
}
async function fenOf(root) {
  return page.locator(root).getAttribute('data-fen')
}
async function waitFen(root, pred, label, timeout = 8000) {
  const t0 = Date.now()
  let fen = null
  while (Date.now() - t0 < timeout) {
    fen = await fenOf(root)
    if (fen && pred(fen)) return fen
    await sleep(60)
  }
  throw new Error(`timeout waiting for ${label} (fen ${fen})`)
}
const board4 = (fen) => fen.split(' ').slice(0, 4).join(' ')

// ================================================================= journey
let ok = true
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // ------------------------------------------------------------- 0. shell + health
  await check('app loads from the backend and reports Stockfish + Ollama healthy', async () => {
    const health = await api('/api/health')
    assert(health.ok && health.stockfish?.name, `health ${JSON.stringify(health)}`)
    assert(health.ollama?.ok && health.ollama.models.includes(MODEL), `Ollama not ready or ${MODEL} missing: ${JSON.stringify(health.ollama)}`)
    await page.locator('.nav-item', { hasText: 'Learn' }).waitFor({ timeout: 10000 })
    await page.waitForFunction(() => document.querySelectorAll('.nav-status .status-dot.ok').length === 2, null, { timeout: 10000 })
    return `${health.stockfish.name}, ${health.openings} openings, ${health.ollama.models.length} models`
  })

  // ------------------------------------------------------------- 1. Learn
  const opening = await api(`/api/openings/${OPENING_ID}`)
  const nodes = new Map()
  const walk = (n) => {
    nodes.set(n.id, n)
    n.children.forEach(walk)
  }
  walk(opening.tree)

  ok = await check('Learn: gallery lists the openings and opens one', async () => {
    await gotoTab('Learn', '.learn-tab')
    const card = page.locator(`.learn-card[data-opening-id="${OPENING_ID}"]`)
    await card.waitFor({ timeout: 10000 })
    const cards = await page.locator('.learn-card').count()
    const summaries = await api('/api/openings')
    assert(cards === summaries.length, `${cards} cards for ${summaries.length} openings`)
    await shot('01-learn-gallery')
    await card.click()
    await page.locator('.learn-tree-move[data-node-id]').first().waitFor({ timeout: 10000 })
    const title = await page.locator('.learn-tab').innerText()
    assert(title.includes(opening.name), `opening name "${opening.name}" not shown`)
    return `${cards} cards; opened ${opening.name}`
  })

  if (ok) {
    await check('Learn: click 5 tree nodes, board + why follow the API tree', async () => {
      // visible tree moves, spread over the tree (main line and variations)
      const ids = await page.locator('.learn-tree-move[data-node-id]').evaluateAll((els) =>
        els.filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-node-id')),
      )
      assert(ids.length >= 5, `only ${ids.length} visible tree nodes`)
      const picks = [0, 2, 5, Math.floor(ids.length / 2), ids.length - 1].map((i) => ids[Math.min(i, ids.length - 1)])
      const seen = []
      for (const id of picks) {
        const node = nodes.get(id)
        assert(node, `tree node "${id}" is not in the API tree`)
        await page.locator(`.learn-tree-move[data-node-id="${id}"]`).first().click()
        await waitFen('.learn-tab .board-root', (f) => board4(f) === board4(node.fen), `board at ${id}`)
        await page.waitForFunction(
          (san) => (document.querySelector('[data-testid="learn-current-move"]')?.textContent ?? '').includes(san),
          node.san,
          { timeout: 4000 },
        )
        const why = (await page.getByTestId('learn-why').innerText()).trim()
        assert(why.length > 10, `no why text at ${id}`)
        if (node.why) assert(why.includes(node.why.slice(0, 60)), `why at ${id} does not match the API: "${why.slice(0, 80)}"`)
        const selected = await page.locator('.learn-tree-move.selected').first().getAttribute('data-node-id')
        assert(selected === id, `selected tree node ${selected}, expected ${id}`)
        seen.push(`${node.san}: "${why.slice(0, 50)}..."`)
      }
      await shot('02-learn-node-why')
      return seen.join(' | ')
    })
  }

  // ------------------------------------------------------------- 2. Quiz (position quiz)
  const ROOT_Q = '[data-testid="quiz-tab"] .board-root'
  const quizItems = await api(`/api/openings/${OPENING_ID}/quiz?mode=positions&limit=5000`)
  const turnOf = () => page.getByTestId('quiz-exercise').getAttribute('data-turn')
  const waitTurn = (want, timeout = 6000) =>
    page.waitForFunction(
      (w) => document.querySelector('[data-testid="quiz-exercise"]')?.getAttribute('data-turn') === w,
      want,
      { timeout },
    )

  ok = await check('Quiz: position quiz starts for the chosen opening', async () => {
    await gotoTab('Quiz', '[data-testid="quiz-settings"]')
    await page.getByTestId('quiz-opening-all').click()
    await page.getByTestId(`quiz-opening-${OPENING_ID}`).click()
    await page.getByTestId('quiz-mode-positions').click()
    await waitTurn('student', 10000)
    return `${quizItems.length} position items from the API`
  })

  let quizCorrect = false
  if (ok) {
    quizCorrect = await check('Quiz: the API answer played on the board (drag) is accepted', async () => {
      const id = await page.getByTestId('quiz-exercise').getAttribute('data-item-id')
      const item = quizItems.find((i) => i.id === id)
      assert(item, `shown item "${id}" is not in the API quiz list`)
      const fen = await fenOf(ROOT_Q)
      assert(board4(fen) === board4(item.fen), `board ${fen} != item fen ${item.fen}`)
      const answer = item.answers[0]
      const mv = new Chess(item.fen).move(answer.san)
      await drag(ROOT_Q, mv.from, mv.to)
      if (mv.promotion) await page.locator(`${ROOT_Q} .board-promo button[data-piece="${mv.promotion}"]`).click()
      await waitTurn('done', 4000)
      const fb = page.getByTestId('quiz-feedback')
      const tone = await fb.getAttribute('data-tone')
      assert(tone === 'good', `feedback tone "${tone}"`)
      const text = await fb.innerText()
      assert(text.includes(answer.san), `feedback does not name ${answer.san}: ${text}`)
      await shot('03-quiz-correct')
      return `${id || '(root)'}: played ${answer.san} (answers ${item.answers.map((a) => a.san).join('/')})`
    })
  }

  if (ok) {
    await check('Quiz: a wrong move (click-click) reveals the book answer', async () => {
      if (quizCorrect || (await turnOf()) === 'done') {
        await page.getByTestId('quiz-next').click()
        await waitTurn('student', 6000)
      }
      const id = await page.getByTestId('quiz-exercise').getAttribute('data-item-id')
      const item = quizItems.find((i) => i.id === id)
      assert(item, `shown item "${id}" is not in the API quiz list`)
      const fen = await fenOf(ROOT_Q)
      // every book move from this position (including transposed twins) counts as right, so avoid them all
      const avoid = new Set(quizItems.filter((i) => board4(i.fen) === board4(fen)).flatMap((i) => i.answers.map((a) => a.san)))
      const legal = new Chess(fen).moves({ verbose: true }).filter((m) => !avoid.has(m.san) && !m.promotion)
      const wrong = legal.find((m) => m.piece === 'p') ?? legal[0]
      assert(wrong, 'no wrong move available')
      await clickMove(ROOT_Q, wrong.from, wrong.to)
      await waitTurn('done', 4000)
      const fb = page.getByTestId('quiz-feedback')
      const tone = await fb.getAttribute('data-tone')
      assert(tone === 'reveal', `feedback tone "${tone}" after a wrong move`)
      const text = await fb.innerText()
      assert(text.includes(item.answers[0].san), `reveal does not name ${item.answers[0].san}: ${text}`)
      const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('quiz-stats-v1') ?? '{}'))
      assert(stats[OPENING_ID]?.[item.id]?.wrong >= 1, 'wrong answer not stored in quiz-stats-v1')
      await shot('04-quiz-wrong')
      return `${wrong.san} rejected, book: ${item.answers.map((a) => a.san).join('/')}`
    })
  }

  // ------------------------------------------------------------- 3. Analyze
  const ROOT_A = '[data-testid="analyze-board"] .board-root'
  const ENGINE = '[data-testid="analyze-engine"]'
  const maxLineDepth = () =>
    page.evaluate((sel) => {
      const ds = [...document.querySelectorAll(`${sel} .engine-line .engine-depth`)].map((e) => Number((e.textContent ?? '').replace(/\D/g, '')))
      return ds.length ? Math.max(...ds) : 0
    }, ENGINE)

  ok = await check('Analyze: engine toggle off/on, live lines reach depth >= 10', async () => {
    await gotoTab('Analyze', '[data-testid="analyze-tab"]')
    await page.locator(`${ROOT_A} cg-board piece`).first().waitFor({ timeout: 10000 })
    const toggle = page.locator('[data-testid="analyze-tab"] .analyze-engine-toggle')
    const input = toggle.locator('input')
    if (!(await input.isChecked())) await toggle.click()
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .engine-line`).length > 0, ENGINE, { timeout: 15000 })
    await toggle.click() // off
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .engine-line`).length === 0, ENGINE, { timeout: 5000 })
    assert(!(await input.isChecked()), 'toggle did not turn the engine off')
    await toggle.click() // on again
    await page.waitForFunction(
      (sel) => {
        const ds = [...document.querySelectorAll(`${sel} .engine-line .engine-depth`)].map((e) => Number((e.textContent ?? '').replace(/\D/g, '')))
        return ds.length > 0 && Math.max(...ds) >= 10
      },
      ENGINE,
      { timeout: 30000 },
    )
    const lines = await page.locator(`${ENGINE} .engine-line`).count()
    const d = await maxLineDepth()
    await shot('05-analyze-engine')
    return `${lines} lines at depth ${d}`
  })

  if (ok) {
    await check('Analyze: play 2 moves, move list + engine follow', async () => {
      const start = await fenOf(ROOT_A)
      const c = new Chess(start)
      const m1 = c.move('e4')
      await drag(ROOT_A, m1.from, m1.to)
      await waitFen(ROOT_A, (f) => board4(f) === board4(c.fen()), 'after 1.e4')
      const m2 = c.move('c5')
      await clickMove(ROOT_A, m2.from, m2.to)
      await waitFen(ROOT_A, (f) => board4(f) === board4(c.fen()), 'after 1...c5')
      const cells = await page.locator('.analyze-movelist .move-cell[data-ply]').count()
      assert(cells === 2, `move list has ${cells} moves`)
      // the engine restarts on the new position: wait until every line's first PV move is legal there
      const legal = new Chess(c.fen()).moves()
      let firstPv = ''
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        const firsts = await page.locator(`${ENGINE} .engine-line`).evaluateAll((els) =>
          els.map((e) => e.querySelector('.pv-move')?.textContent ?? ''),
        )
        if (firsts.length > 0 && firsts.every((s) => legal.includes(s))) {
          firstPv = firsts[0]
          break
        }
        await sleep(100)
      }
      assert(firstPv, 'engine lines never switched to the position after 1.e4 c5')
      await page.waitForFunction((sel) => {
        const ds = [...document.querySelectorAll(`${sel} .engine-line .engine-depth`)].map((e) => Number((e.textContent ?? '').replace(/\D/g, '')))
        return ds.length > 0 && Math.max(...ds) >= 8
      }, ENGINE, { timeout: 20000 })
      const opening = await page.getByTestId('analyze-opening').innerText().catch(() => '')
      await shot('06-analyze-moves')
      return `1.e4 c5 played; engine best ${firstPv}; opening label "${opening.split('\n')[0]}"`
    })
  }

  // ------------------------------------------------------------- 4. Play
  const TAB_P = '[data-testid="play-tab"]'
  const ROOT_P = `${TAB_P} .board-root`
  const playState = () =>
    page.locator(TAB_P).evaluate((el) => ({
      id: el.dataset.gameId,
      turn: el.dataset.turn,
      over: el.dataset.over === 'true',
      thinking: el.dataset.thinking === 'true',
      plies: Number(el.dataset.plies),
      fen: el.querySelector('.board-root')?.getAttribute('data-fen'),
    }))
  async function waitPlay(pred, label, timeout = 30000) {
    const t0 = Date.now()
    let s
    while (Date.now() - t0 < timeout) {
      s = await playState()
      if (pred(s)) return s
      await sleep(80)
    }
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
  }

  ok = await check('Play: start a game as White at Elo 1200', async () => {
    await gotoTab('Play', TAB_P)
    const setup = page.locator(`${TAB_P} [data-testid="play-setup"]`)
    await setup.waitFor({ timeout: 8000 })
    await setup.locator('[data-color="white"]').click()
    await setup.locator('[data-elo="1200"]').click()
    const elo = await page.getByTestId('play-elo-value').first().innerText()
    assert(elo.trim() === '1200', `elo shows ${elo}`)
    const caption = await page.getByTestId('play-strength-caption').first().innerText()
    await shot('07-play-setup')
    await page.locator(`${TAB_P} [data-testid="play-start"]`).click()
    const s = await waitPlay((x) => x.id && x.turn === 'white' && !x.thinking && x.plies === 0, 'game started')
    const o = await page.locator(ROOT_P).getAttribute('data-orientation')
    assert(o === 'white', `board orientation ${o}`)
    return `game ${s.id}; caption "${caption}"`
  })

  if (ok) {
    await check('Play: 3 student moves get 3 bot replies (Skill Level mode below 1320)', async () => {
      const plan = ['e4', 'Nf3', 'Bc4', 'd4', 'Nc3', 'Be2', 'h3', 'a3']
      const played = []
      for (let i = 0; i < 3; i++) {
        const s = await waitPlay((x) => x.over || (x.turn === 'white' && !x.thinking), 'student turn', 40000)
        assert(!s.over, 'game ended early')
        const c = new Chess(s.fen)
        const legal = c.moves()
        const san = plan.find((p) => legal.includes(p) && !played.includes(p)) ?? legal[0]
        const mv = c.move(san)
        if (i === 1) await clickMove(ROOT_P, mv.from, mv.to)
        else await drag(ROOT_P, mv.from, mv.to)
        await waitPlay((x) => x.plies >= s.plies + 1, `student move ${san} applied`, 5000)
        await waitPlay((x) => x.over || x.plies >= s.plies + 2, 'bot reply', 40000)
        played.push(san)
      }
      const s = await playState()
      assert(s.plies === 6, `expected 6 plies, got ${s.plies}`)
      const cells = await page.locator(`${TAB_P} .move-cell[data-ply]`).count()
      assert(cells === 6, `move list shows ${cells} moves`)
      assert(botResponses.length >= 3, `${botResponses.length} bot responses`)
      const modes = botResponses.slice(-3).map((r) => `${r.san}:${r.strength.mode}${r.strength.skill !== undefined ? `/skill ${r.strength.skill}` : ''}`)
      assert(botResponses.slice(-3).every((r) => r.strength.mode === 'skill' && r.strength.elo === 1200), `strength ${modes.join(', ')}`)
      await shot('08-play-moves')
      return `${played.join(' ')}; bot ${modes.join(', ')}`
    })
  }

  // ------------------------------------------------------------- 5. Review
  ok = await check(`Review: paste PGN, review at depth ${DEPTH} to completion`, async () => {
    await gotoTab('Review', '[data-testid="review-setup"]')
    await page.locator('.review-model-select select').first().waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: 'Paste PGN' }).click()
    await page.getByTestId('review-pgn').fill(REVIEW_PGN)
    await page.getByTestId('review-depth-input').fill(DEPTH)
    await page.getByTestId('review-depth-input').blur()
    await page.getByTestId('review-start').click()
    await page.getByTestId('review-progress-label').waitFor({ timeout: 8000 })
    await shot('09-review-progress')
    await page.locator('[data-testid="review-tab"][data-phase="done"]').waitFor({ timeout: 240000 })
    await sleep(300)
    await shot('10-review-summary')
  })

  let flaggedPly = 0
  if (ok) {
    await check('Review: accuracy numbers and mistake/blunder badges', async () => {
      const w = (await page.getByTestId('review-accuracy-white').textContent())?.trim() ?? ''
      const b = (await page.getByTestId('review-accuracy-black').textContent())?.trim() ?? ''
      for (const v of [w, b]) {
        assert(/^\d{1,3}(\.\d)?$/.test(v) && Number(v) >= 0 && Number(v) <= 100, `accuracy "${w}" / "${b}"`)
      }
      const countOf = async (cls) =>
        page.locator(`[data-testid="review-counts"] tr[data-classification="${cls}"] .review-count`).evaluateAll((els) =>
          els.reduce((s, e) => s + Number(e.textContent || 0), 0),
        )
      const bad = (await countOf('blunder')) + (await countOf('mistake'))
      assert(bad >= 1, 'no mistake or blunder counted')
      const all = await page.locator('[data-testid="review-counts"] .review-count').evaluateAll((els) => els.reduce((s, e) => s + Number(e.textContent || 0), 0))
      assert(all === REVIEW_PLIES, `counts sum to ${all}, expected ${REVIEW_PLIES}`)
      const moments = await page.locator('.review-moment').evaluateAll((els) =>
        els.map((e) => ({ ply: Number(e.getAttribute('data-ply')), text: e.textContent ?? '' })),
      )
      const flagged = moments.filter((m) => /Blunder|Mistake/.test(m.text))
      assert(flagged.length >= 1, `no blunder/mistake badge among key moments: ${moments.map((m) => m.text).join(' | ')}`)
      flaggedPly = (flagged.find((m) => /Blunder/.test(m.text)) ?? flagged[0]).ply
      return `accuracy W ${w} / B ${b}; ${bad} mistakes+blunders; flagged plies ${flagged.map((m) => m.ply).join(',')}`
    })
  }

  if (ok && flaggedPly) {
    await check('Review: click a flagged move -> board, best move, details', async () => {
      await page.locator(`.review-moment[data-ply="${flaggedPly}"]`).click()
      await page.getByTestId('review-details').waitFor({ timeout: 5000 })
      const cls = await page.locator('.review-facts').getAttribute('data-classification')
      assert(cls === 'blunder' || cls === 'mistake', `details show "${cls}"`)
      const cur = await page.locator('.review-movelist .move-cell.current').getAttribute('data-ply')
      assert(Number(cur) === flaggedPly, `current move ${cur}, expected ${flaggedPly}`)
      const verdict = await page.getByTestId('review-verdict').textContent()
      const best = await page.getByTestId('review-best-move').textContent().catch(() => '')
      const arrows = await page.locator('.review-overlay-svg line').count()
      assert(arrows >= 1, 'no arrows drawn for the played/best move')
      return `${verdict?.trim()}; best ${best?.trim()}`
    })

    await check(`Review: Explain streams an explanation (${MODEL})`, async () => {
      const select = page.locator('.review-explain .review-model-select select')
      await select.waitFor({ timeout: 5000 })
      await select.selectOption(MODEL)
      await page.getByTestId('review-explain-btn').click()
      const text = page.getByTestId('review-explain-text')
      await text.waitFor({ timeout: 90000 })
      const lengths = []
      const t0 = Date.now()
      while (Date.now() - t0 < 120000) {
        const len = ((await text.textContent()) ?? '').length
        if (lengths.length === 0 || len !== lengths[lengths.length - 1]) lengths.push(len)
        if ((await page.locator('.review-explain-text.streaming').count()) === 0 && len > 0) break
        await sleep(80)
      }
      const final = ((await text.textContent()) ?? '').trim()
      const err = await page.getByTestId('review-explain-error').textContent().catch(() => null)
      assert(!err, `explain error: ${err}`)
      assert(final.length > 40, `explanation too short: "${final}"`)
      assert(lengths.length >= 3, `text did not stream in (lengths ${lengths.join(',')})`)
      await shot('11-review-explain')
      return `${lengths.length} growth steps, ${final.length} chars: "${final.slice(0, 100)}..."`
    })
  }

  // ------------------------------------------------------------- console / exceptions
  await check('no uncaught exceptions', async () => {
    assert(pageErrors.length === 0, pageErrors.join(' | '))
  })
  await check('no console errors', async () => {
    assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
  })
} catch (err) {
  record('journey crashed', false, err instanceof Error ? err.stack ?? err.message : String(err))
  await shot('FAIL-crash').catch(() => {})
} finally {
  await browser.close()
}

console.log('')
if (httpErrors.length) console.log(`HTTP errors seen (informational): ${httpErrors.join('; ')}`)
console.log(`${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
