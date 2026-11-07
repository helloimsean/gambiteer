// Playwright end-to-end check of the Quiz tab (needs the backend on :8000 and `npm run dev`).
//
//   node src/tabs/Quiz/QuizTab.e2e.mjs [baseUrl]        (cwd: frontend/)
//
// Drives line drill (White and Black), position quiz (weighting, any book child, transpositions,
// reveal, Show move), traps (to the end of the trap line), stats persistence across reload,
// reset, the Learn hand-offs and the 1100 px layout. Screenshots go to frontend/screenshots/Quiz-*.png.
// NOTE: it overwrites the browser context's localStorage `quiz-stats-v1` (fresh Playwright profile).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { Chess } from 'chess.js'

const FRONTEND = fileURLToPath(new URL('../../../', import.meta.url))
const BASE = process.argv[2] ?? 'http://localhost:5173'
const SHOTS = join(FRONTEND, 'screenshots')
mkdirSync(SHOTS, { recursive: true })

let failed = 0
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
async function check(name, fn) {
  try {
    const d = await fn()
    record(name, true, typeof d === 'string' ? d : '')
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err))
  }
}
function assert(c, m) {
  if (!c) throw new Error(m)
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json()
}

const ROOT = '[data-testid="quiz-tab"] .board-root'
const fen4 = (f) => f.split(' ').slice(0, 4).join(' ')

async function fenOf(page) {
  return page.locator(ROOT).getAttribute('data-fen')
}
async function turnOf(page) {
  return page.locator('[data-testid="quiz-exercise"]').getAttribute('data-turn')
}
async function waitTurn(page, want, timeout = 4000) {
  await page.waitForFunction(
    (w) => document.querySelector('[data-testid="quiz-exercise"]')?.getAttribute('data-turn') === w,
    want,
    { timeout },
  )
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
  const box = await page.locator(`${ROOT} cg-board`).boundingBox()
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
async function playSan(page, san) {
  const fen = await fenOf(page)
  const c = new Chess(fen)
  const m = c.move(san)
  await drag(page, m.from, m.to)
  return m
}
function childrenAt(tree, sans) {
  let node = tree
  for (const s of sans) {
    node = node.children.find((c) => c.san === s)
    if (!node) return []
  }
  return node.children.map((c) => c.san)
}
/** A legal move in `fen` that is not in `avoid` (SANs); prefers quiet pawn moves. */
function wrongMove(fen, avoid) {
  const c = new Chess(fen)
  const moves = c.moves({ verbose: true }).filter((m) => !avoid.includes(m.san))
  return moves.find((m) => m.piece === 'p') ?? moves[0]
}
async function shot(page, name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(SHOTS, `Quiz-${name}.png`) })
}
async function stats(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('quiz-stats-v1') ?? '{}'))
}
async function openQuiz(page) {
  await page.locator('.nav-item', { hasText: 'Quiz' }).click()
  await page.waitForSelector('[data-testid="quiz-settings"]', { timeout: 8000 })
}
async function onlyOpening(page, id) {
  // from "All", clicking a chip focuses that opening; otherwise click "All" first
  await page.locator('[data-testid="quiz-opening-all"]').click()
  await page.locator(`[data-testid="quiz-opening-${id}"]`).click()
  await page.waitForTimeout(200)
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
page.on('response', (r) => {
  if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`)
})

const alien = await getJson('/api/openings/alien-gambit')
const caro = await getJson('/api/openings/caro-kann')

await page.goto(BASE)
await openQuiz(page)

// ---------- 1. line drill, White
const LINE = alien.lines.find((l) => l.id === 'alien-accepted-c5') ?? alien.lines[0]
await check('line drill: pick a specific line', async () => {
  await onlyOpening(page, 'alien-gambit')
  await page.locator('[data-testid="quiz-line-select"]').selectOption(`alien-gambit::${LINE.id}`)
  await page.waitForTimeout(400)
  const fen = await fenOf(page)
  assert(fen4(fen) === fen4(new Chess().fen()), `expected start position, got ${fen}`)
  assert((await turnOf(page)) === 'student', 'student should be to move')
  await shot(page, '01-line-start')
  return LINE.name
})

await check('line drill: first wrong move shakes and says Try again', async () => {
  const fen = await fenOf(page)
  const w = wrongMove(fen, [LINE.sans[0], ...childrenAt(alien.tree, [])])
  await page.evaluate((sel) => {
    window.__quizShook = false
    const el = document.querySelector(sel)
    const mo = new MutationObserver(() => {
      if (el.classList.contains('board-shake')) window.__quizShook = true
    })
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
  }, ROOT)
  await drag(page, w.from, w.to)
  await page.waitForTimeout(300)
  const shaking = await page.evaluate(() => window.__quizShook)
  const fenAfter = await fenOf(page)
  assert(fenAfter === fen, 'wrong move must be rejected (fen unchanged)')
  const tone = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone === 'bad', `feedback tone ${tone}`)
  const status = await page.locator('[data-testid="quiz-status"]').innerText()
  assert(/Try again/i.test(status), `status: ${status}`)
  assert(shaking, 'board should shake')
  await shot(page, '02-line-try-again')
  return `${w.san} rejected`
})

await check('line drill: correct move accepted and opponent replies from the line after ~400 ms', async () => {
  await playSan(page, LINE.sans[0])
  const t0 = Date.now()
  const afterStudent = await fenOf(page)
  assert(fen4(afterStudent) === fen4(new Chess().move(LINE.sans[0]).after), 'student move should be on the board')
  const tone = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone === 'good', `feedback tone ${tone}`)
  await waitTurn(page, 'student', 3000)
  const dt = Date.now() - t0
  const c = new Chess()
  c.move(LINE.sans[0])
  c.move(LINE.sans[1])
  assert(fen4(await fenOf(page)) === fen4(c.fen()), 'opponent reply should follow the line')
  assert(dt >= 250, `reply came too fast (${dt} ms)`)
  const note = await page.locator('[data-testid="quiz-opponent-note"]').count()
  await shot(page, '03-line-opponent-replied')
  return `reply ${LINE.sans[1]} after ${dt} ms (incl. test overhead), opponent why shown: ${note > 0}`
})

await check('line drill: second wrong move reveals the correct move and its why', async () => {
  const fen = await fenOf(page)
  const expected = LINE.sans[2]
  const avoid = [expected, ...childrenAt(alien.tree, LINE.sans.slice(0, 2))]
  const w1 = wrongMove(fen, avoid)
  await drag(page, w1.from, w1.to)
  await page.waitForTimeout(500)
  const w2 = wrongMove(fen, [...avoid, w1.san])
  await drag(page, w2.from, w2.to)
  const fb = page.locator('[data-testid="quiz-feedback"]')
  const tone = await fb.getAttribute('data-tone')
  assert(tone === 'reveal', `feedback tone ${tone}`)
  const text = await fb.innerText()
  assert(text.includes(expected), `reveal should name ${expected}: ${text}`)
  const node = alien.tree.children[0].children[0].children.find((x) => x.san === expected)
  assert(node && text.includes(node.why.slice(0, 30)), 'reveal should include the why')
  await shot(page, '04-line-reveal')
  return `revealed ${expected}`
})

await check('line drill: Enter plays the revealed move, then the line finishes with a summary', async () => {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  // play the rest of the line
  const c = new Chess()
  for (let guard = 0; guard < 80; guard++) {
    const turn = await turnOf(page)
    if (turn === 'done') break
    if (turn === 'opponent') {
      await page.waitForTimeout(150)
      continue
    }
    const fen = await fenOf(page)
    // where are we in the line?
    const cc = new Chess()
    let ply = -1
    for (let i = 0; i <= LINE.sans.length; i++) {
      if (fen4(cc.fen()) === fen4(fen)) {
        ply = i
        break
      }
      if (i < LINE.sans.length) cc.move(LINE.sans[i])
    }
    assert(ply >= 0, `position not on the line: ${fen}`)
    await playSan(page, LINE.sans[ply])
    await page.waitForTimeout(100)
  }
  void c
  await waitTurn(page, 'done', 3000)
  const mistakes = await page.locator('[data-testid="quiz-summary-mistakes"]').innerText()
  assert(mistakes.trim() === '1', `mistakes should be 1, got ${mistakes}`)
  await shot(page, '05-line-summary')
  const st = await stats(page)
  const root = st['alien-gambit']?.['']
  assert(root && root.wrong === 1 && root.correct === 0, `root stat ${JSON.stringify(root)}`)
  return `summary shows 1 mistake; stats nodes: ${Object.keys(st['alien-gambit'] ?? {}).length}`
})

await check('line drill: Enter = Next line', async () => {
  const before = await page.locator('[data-testid="quiz-line-select"]').inputValue()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  const after = await page.locator('[data-testid="quiz-line-select"]').inputValue()
  assert(after !== before, 'line choice should advance')
  assert((await turnOf(page)) === 'student', 'new line should start with the student to move')
  return `${before} -> ${after}`
})

// ---------- 2. line drill, Black: the app plays White's first move
await check('line drill (Black): app plays White\'s first move, board oriented black', async () => {
  await onlyOpening(page, 'caro-kann')
  await page.locator('[data-testid="quiz-line-select"]').selectOption('caro-kann::classical-main')
  await waitTurn(page, 'student', 4000)
  const o = await page.locator(ROOT).getAttribute('data-orientation')
  assert(o === 'black', `orientation ${o}`)
  const line = caro.lines.find((l) => l.id === 'classical-main')
  const c = new Chess()
  c.move(line.sans[0])
  assert(fen4(await fenOf(page)) === fen4(c.fen()), 'White first move should be played')
  await playSan(page, line.sans[1])
  await waitTurn(page, 'student', 3000)
  await shot(page, '06-line-black')
  return `${line.sans[0]} auto-played, ${line.sans[1]} accepted`
})

// ---------- 3. position quiz: any valid child is accepted
// pick a position with >= 2 answers; make every other position "known" so the weighting asks it first
const posItems = await getJson('/api/openings/caro-kann/quiz?mode=positions&limit=5000')
const multi = posItems.find((i) => i.answers.length >= 2)
await check('position quiz: weak position comes first and a non-first book move counts as correct', async () => {
  assert(multi, 'need an item with 2+ answers in caro-kann')
  const seed = {}
  for (const it of posItems) seed[it.id] = { correct: 3, wrong: 0, lastSeen: Date.now() }
  seed[multi.id] = { correct: 0, wrong: 2, lastSeen: Date.now() - 1000 }
  await page.evaluate((s) => localStorage.setItem('quiz-stats-v1', JSON.stringify({ 'caro-kann': s })), seed)
  await page.reload()
  await openQuiz(page)
  await onlyOpening(page, 'caro-kann')
  await page.locator('[data-testid="quiz-mode-positions"]').click()
  await waitTurn(page, 'student', 6000)
  const fen = await fenOf(page)
  assert(fen === multi.fen, `expected the weak position ${multi.id}, got ${fen}`)
  await shot(page, '07-positions-start')
  const ans = multi.answers[1]
  await playSan(page, ans.san)
  await waitTurn(page, 'done', 2000)
  const fb = page.locator('[data-testid="quiz-feedback"]')
  assert((await fb.getAttribute('data-tone')) === 'good', 'second answer should be correct')
  const text = await fb.innerText()
  assert(ans.lineNames.some((n) => text.includes(n)), `feedback should list the line: ${text}`)
  await shot(page, '08-positions-correct')
  return `${multi.id}: played ${ans.san} (answers: ${multi.answers.map((a) => a.san).join(', ')})`
})

await check('position quiz: Enter = Next, wrong answer reveals the book move(s)', async () => {
  const before = await fenOf(page)
  await page.keyboard.press('Enter')
  await waitTurn(page, 'student', 3000)
  const fen = await fenOf(page)
  assert(fen !== before, 'a new position should be shown')
  const shownId = await page.locator('[data-testid="quiz-exercise"]').getAttribute('data-item-id')
  const item = posItems.find((i) => i.id === shownId)
  assert(item && item.fen === fen, 'shown position should be a quiz item')
  // transposed twins' book moves count as well
  const twinSans = posItems.filter((i) => fen4(i.fen) === fen4(fen)).flatMap((i) => i.answers.map((a) => a.san))
  const w = wrongMove(fen, [...item.answers.map((a) => a.san), ...twinSans])
  await drag(page, w.from, w.to)
  await waitTurn(page, 'done', 2000)
  const fb = page.locator('[data-testid="quiz-feedback"]')
  assert((await fb.getAttribute('data-tone')) === 'reveal', 'should reveal')
  const text = await fb.innerText()
  assert(text.includes(item.answers[0].san), 'reveal names the answer')
  const status = await page.locator('[data-testid="quiz-status"]').innerText()
  await shot(page, '09-positions-reveal')
  const st = await stats(page)
  assert(st['caro-kann'][item.id].wrong >= 1, 'wrong recorded')
  return `${w.san} wrong; status "${status.split('\n')[0]}"`
})

await check('position quiz: a book move from a transposed twin position also counts', async () => {
  // twin = same position, other move order, with a book move the shown item does not have
  let pair = null
  for (const a of posItems) {
    for (const b of posItems) {
      if (a === b || fen4(a.fen) !== fen4(b.fen)) continue
      const extra = b.answers.find((x) => !a.answers.some((y) => y.uci === x.uci))
      if (extra) {
        pair = { a, b, extra }
        break
      }
    }
    if (pair) break
  }
  if (!pair) return 'skipped (no transposition with different book moves in caro-kann)'
  const seed = {}
  for (const it of posItems) seed[it.id] = { correct: 3, wrong: 0, lastSeen: Date.now() }
  seed[pair.a.id] = { correct: 0, wrong: 3, lastSeen: Date.now() - 1000 }
  await page.evaluate((s) => localStorage.setItem('quiz-stats-v1', JSON.stringify({ 'caro-kann': s })), seed)
  await page.reload()
  await openQuiz(page)
  await onlyOpening(page, 'caro-kann')
  await page.locator('[data-testid="quiz-mode-positions"]').click()
  await waitTurn(page, 'student', 6000)
  const shownId = await page.locator('[data-testid="quiz-exercise"]').getAttribute('data-item-id')
  assert(shownId === pair.a.id, `expected ${pair.a.id}, got ${shownId}`)
  await playSan(page, pair.extra.san)
  await waitTurn(page, 'done', 2000)
  const tone = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone === 'good', `tone ${tone}`)
  return `${pair.a.id}: ${pair.extra.san} (book via ${pair.b.id}) accepted`
})

// ---------- 4. traps
const trapItems = await getJson('/api/openings/alien-gambit/quiz?mode=traps&limit=5000')
await check('traps: find the punishing move and finish the trap line', async () => {
  await onlyOpening(page, 'alien-gambit')
  await page.locator('[data-testid="quiz-mode-traps"]').click()
  await waitTurn(page, 'student', 6000)
  const fen = await fenOf(page)
  const shownId = await page.locator('[data-testid="quiz-exercise"]').getAttribute('data-item-id')
  const item = trapItems.find((i) => i.id === shownId)
  assert(item, `trap position not found for ${fen}`)
  await shot(page, '10-traps-start')
  const answer = item.answers[0]
  await playSan(page, answer.san)
  const tone = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone === 'good', `first trap move should be correct, tone ${tone}`)
  // continue to the end of the trap line
  const lines = alien.lines.filter((l) => answer.lineIds.includes(l.id))
  let moves = 1
  for (let guard = 0; guard < 60; guard++) {
    const turn = await turnOf(page)
    if (turn === 'done') break
    if (turn === 'opponent') {
      await page.waitForTimeout(150)
      continue
    }
    const cur = await fenOf(page)
    let next = null
    for (const l of lines) {
      const c = new Chess()
      for (let i = 0; i < l.sans.length; i++) {
        if (fen4(c.fen()) === fen4(cur)) {
          next = l.sans[i]
          break
        }
        c.move(l.sans[i])
      }
      if (next) break
    }
    assert(next, 'continuation move not found')
    await playSan(page, next)
    moves += 1
  }
  await waitTurn(page, 'done', 3000)
  await shot(page, '11-traps-done')
  return `${item.id.split(' ').length} plies in, ${moves} student move(s), lines: ${answer.lineNames.join(' | ')}`
})

// ---------- 5. persistence
await check('stats persist in localStorage across reload (mastery shown)', async () => {
  const before = await stats(page)
  const seenAlien = Object.keys(before['alien-gambit'] ?? {}).length
  const seenCaro = Object.keys(before['caro-kann'] ?? {}).length
  assert(seenAlien > 0 && seenCaro > 0, 'stats should have entries')
  await page.reload()
  await openQuiz(page)
  await page.locator('[data-testid="quiz-opening-all"]').click()
  await page.waitForTimeout(300)
  const after = await stats(page)
  assert(JSON.stringify(after) === JSON.stringify(before), 'stats changed across reload')
  const rowA = page.locator('[data-testid="quiz-mastery-alien-gambit"]')
  const rowC = page.locator('[data-testid="quiz-mastery-caro-kann"]')
  assert(Number(await rowA.getAttribute('data-seen')) === seenAlien, 'alien mastery seen count')
  assert(Number(await rowC.getAttribute('data-seen')) === seenCaro, 'caro mastery seen count')
  await shot(page, '12-after-reload')
  return `alien ${await rowA.getAttribute('data-pct')}% of ${seenAlien}, caro ${await rowC.getAttribute('data-pct')}% of ${seenCaro}`
})

await check('session streak / score update', async () => {
  // fresh session after reload: play one correct move in line drill
  await page.locator('[data-testid="quiz-mode-line"]').click()
  await onlyOpening(page, 'alien-gambit')
  await page.locator('[data-testid="quiz-line-select"]').selectOption(`alien-gambit::${LINE.id}`)
  await waitTurn(page, 'student', 4000)
  await playSan(page, LINE.sans[0])
  await page.waitForTimeout(200)
  const streak = await page.locator('[data-testid="quiz-streak"]').innerText()
  const score = await page.locator('[data-testid="quiz-score"]').innerText()
  assert(streak.trim() === '1' && score.trim() === '1/1', `streak ${streak}, score ${score}`)
  return `streak ${streak}, score ${score}`
})

await check('reset stats clears localStorage', async () => {
  await page.locator('[data-testid="quiz-reset"]').click()
  await page.waitForSelector('[aria-modal="true"]')
  await shot(page, '13-reset-modal')
  await page.locator('[data-testid="quiz-reset-all"]').click()
  await page.waitForTimeout(200)
  const st = await stats(page)
  assert(Object.keys(st).length === 0, `stats not empty: ${JSON.stringify(st).slice(0, 80)}`)
  const score = await page.locator('[data-testid="quiz-score"]').innerText()
  assert(score.trim() === '0/0', `score ${score}`)
  return 'cleared'
})

await check('line drill: another repertoire move is "also book", not a mistake', async () => {
  // find a student ply in some alien line where the tree offers more than one move
  let target = null
  for (const l of alien.lines) {
    for (let i = 0; i < l.sans.length; i += 2) {
      const kids = childrenAt(alien.tree, l.sans.slice(0, i))
      if (kids.length > 1) {
        target = { line: l, ply: i, other: kids.find((k) => k !== l.sans[i]) }
        break
      }
    }
    if (target) break
  }
  if (!target) return 'skipped (no branching student position in the data)'
  await page.locator('[data-testid="quiz-mode-line"]').click()
  await onlyOpening(page, 'alien-gambit')
  await page.locator('[data-testid="quiz-line-select"]').selectOption(`alien-gambit::${target.line.id}`)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^restart$/i }).click()
  await waitTurn(page, 'student', 4000)
  for (let i = 0; i < target.ply; i += 2) {
    await playSan(page, target.line.sans[i])
    await waitTurn(page, 'student', 3000)
  }
  const before = await stats(page)
  await playSan(page, target.other)
  const tone = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone === 'info', `tone ${tone}`)
  const after = await stats(page)
  const id = target.line.sans.slice(0, target.ply).join(' ')
  assert(JSON.stringify(before['alien-gambit']?.[id]) === JSON.stringify(after['alien-gambit']?.[id]), 'must not be counted')
  await shot(page, '14-line-also-book')
  await playSan(page, target.line.sans[target.ply])
  const tone2 = await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')
  assert(tone2 === 'good', `then the line move is accepted, tone ${tone2}`)
  return `${target.line.id} ply ${target.ply + 1}: ${target.other} = also book, ${target.line.sans[target.ply]} accepted`
})

await check('position quiz: "Show move" reveals and counts a miss', async () => {
  await page.locator('[data-testid="quiz-mode-positions"]').click()
  await waitTurn(page, 'student', 6000)
  const score0 = await page.locator('[data-testid="quiz-score"]').innerText()
  await page.getByRole('button', { name: /show move/i }).click()
  await waitTurn(page, 'done', 2000)
  assert((await page.locator('[data-testid="quiz-feedback"]').getAttribute('data-tone')) === 'reveal', 'reveal')
  const score1 = await page.locator('[data-testid="quiz-score"]').innerText()
  const [c0, t0] = score0.split('/').map(Number)
  const [c1, t1] = score1.split('/').map(Number)
  assert(c1 === c0 && t1 === t0 + 1, `score ${score0} -> ${score1}`)
  return `score ${score0} -> ${score1}`
})

await check('hand-off from Learn: "Quiz this opening" selects that opening', async () => {
  await page.locator('.nav-item', { hasText: 'Learn' }).click()
  await page.locator('.learn-card-name', { hasText: 'Caro-Kann' }).first().click()
  await page.locator('button[title="Quiz this opening"]').click()
  await page.waitForSelector('[data-testid="quiz-exercise"][data-turn]', { timeout: 6000 })
  await waitTurn(page, 'student', 4000)
  const active = await page.locator('.quiz-openings .quiz-chip.active').allInnerTexts()
  assert(active.length === 1 && /Caro-Kann/.test(active[0]), `active chips: ${active.join(', ')}`)
  const o = await page.locator(ROOT).getAttribute('data-orientation')
  assert(o === 'black', `orientation ${o}`)
  return `chips: ${active.join(', ')}`
})

await check('hand-off from Learn: "Drill this line" starts that line', async () => {
  await page.locator('.nav-item', { hasText: 'Learn' }).click()
  await page.waitForTimeout(600)
  const card = page.locator('.learn-card-name', { hasText: 'Italian' })
  if ((await card.count()) > 0) await card.first().click()
  await page.locator('.panel-tabs button', { hasText: /lines/i }).click()
  const first = page.locator('.learn-line').nth(1)
  const lineId = await first.getAttribute('data-line-id')
  await first.locator('.learn-line-head').click()
  await page.getByRole('button', { name: /drill this line/i }).click()
  await page.waitForSelector('[data-testid="quiz-line-select"]', { timeout: 6000 })
  await waitTurn(page, 'student', 4000)
  const v = await page.locator('[data-testid="quiz-line-select"]').inputValue()
  assert(v.endsWith(`::${lineId}`), `line select ${v}, expected line ${lineId}`)
  await shot(page, '15-handoff-drill-line')
  return v
})

await check('layout at 1100 px wide', async () => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  assert(!overflow, 'horizontal overflow at 1100px')
  await shot(page, '16-narrow-1100')
  const box = await page.locator('[data-testid="quiz-status"]').boundingBox()
  assert(box && box.y + box.height <= 760, 'status bar off-screen')
  return 'ok'
})

const quizErrors = consoleErrors.filter((e) => !/\/src\/tabs\/(Analyze|Learn|Play|Review)\//.test(e) && !/Failed to load resource/.test(e))
console.log('all console errors:', JSON.stringify(consoleErrors, null, 1))
record('no console errors from the Quiz tab', quizErrors.length === 0, quizErrors.slice(0, 5).join(' | '))

await browser.close()
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
