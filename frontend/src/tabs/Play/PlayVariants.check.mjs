// Playwright check of the variants and Panicfish, against the real backend.
//
//   cd frontend && npm run build
//   cd backend  && FAIRY_PATH=tests/fixtures/fake_fairy.py python -m uvicorn app.main:app --port 8095
//   cd frontend && node src/tabs/Play/PlayVariants.check.mjs [baseUrl]   (default http://localhost:8095)
//
// Where a game needs particular replies, /api/bot/move is answered here. Standard chess, Chess960 and
// Panicfish also run on the real Stockfish below; the other variants reach the stand-in engine.
//
// Screenshots go to frontend/screenshots/variants-*.png. Exit code 0 = all checks passed.
import { Chess } from 'chess.js'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8095'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, '../../../screenshots')
mkdirSync(SHOTS, { recursive: true })

const GAME_KEY = 'play-game-v1'
const SETUP_KEY = 'play-setup-v1'
const HISTORY_KEY = 'game-history-v1'

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
const page = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const BOARD = '.board-root'
const tab = () => page.getByTestId('play-tab')
const fen = () => page.locator(BOARD).getAttribute('data-fen')
const shot = (name) => page.screenshot({ path: join(SHOTS, `variants-${name}.png`) })
const attr = (name) => tab().getAttribute(name)
const plies = async () => Number(await attr('data-plies'))
const status = async () => (await page.getByTestId('play-status').innerText()).trim()

/** At least n plies: a scripted reply can land before the student's own move is ever observed alone. */
async function waitPlies(n) {
  await page.waitForFunction((want) => Number(document.querySelector('[data-testid="play-tab"]')?.dataset.plies) >= want, n, { timeout: 15000 })
}
async function waitOver() {
  await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.dataset.over === 'true', null, { timeout: 15000 })
}
async function closeOverDialog() {
  const dialog = page.getByTestId('play-over')
  await dialog.waitFor({ timeout: 4000 })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 3000 })
}

async function squareAt(square) {
  const box = await page.locator(BOARD).boundingBox()
  const flipped = (await page.locator(BOARD).getAttribute('data-orientation')) === 'black'
  const file = 'abcdefgh'.indexOf(square[0])
  const rank = Number(square[1])
  const x = flipped ? 7 - file : file
  const y = flipped ? rank - 1 : 8 - rank
  return [box.x + (x + 0.5) * (box.width / 8), box.y + (y + 0.5) * (box.height / 8)]
}
async function clickSquare(square) {
  await page.mouse.click(...(await squareAt(square)))
}
async function play(uci) {
  await clickSquare(uci.slice(0, 2))
  await clickSquare(uci.slice(2, 4))
}

/** Reset the app with these setup values and open Play. */
async function openPlay(setup = {}, extra = {}) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([setupKey, gameKey, value, more]) => {
      localStorage.removeItem(gameKey)
      localStorage.setItem(setupKey, JSON.stringify(value))
      for (const [k, v] of Object.entries(more)) localStorage.setItem(k, JSON.stringify(v))
    },
    [SETUP_KEY, GAME_KEY, setup, extra],
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await tab().waitFor()
}

async function start(setup) {
  await openPlay({ movetimeMs: 300, ...setup })
  await page.getByTestId('play-start').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.dataset.gameId, null, { timeout: 5000 })
}

/** Load a saved game directly, for positions a normal start would take long to reach. */
async function resume(game) {
  await openPlay({}, {
    [GAME_KEY]: {
      version: 1,
      id: `seeded-${Math.random()}`,
      studentColor: 'white',
      elo: 1500,
      bot: 'stockfish',
      movetimeMs: 300,
      sans: [],
      basePly: 0,
      marks: {},
      bookStats: { correct: 0, missed: 0 },
      startedAt: Date.now(),
      ...game,
    },
  })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.locator(`[data-testid="play-tab"][data-game-id]:not([data-game-id=""])`).waitFor({ timeout: 5000 })
}

/** Answer the bot's next moves from this list, recording each request body. */
async function scriptBot(replies) {
  const queue = [...replies]
  const seen = []
  await page.unroute('**/api/bot/move').catch(() => {})
  await page.route('**/api/bot/move', async (route) => {
    const body = route.request().postDataJSON()
    seen.push(body)
    const uci = queue.shift()
    if (!uci) return route.abort()
    await route.fulfill({ json: { uci, san: uci, fen_after: body.fen, eval: null, strength: { mode: 'uci_elo', elo: body.elo } } })
  })
  return seen
}

async function realBot() {
  await page.unroute('**/api/bot/move').catch(() => {})
}

/** Plays student moves, waiting for each scripted reply. */
async function playLine(moves) {
  for (const uci of moves) {
    const before = await plies()
    await play(uci)
    await page.waitForFunction(
      (want) => {
        const t = document.querySelector('[data-testid="play-tab"]')?.dataset
        return t?.over === 'true' || Number(t?.plies) >= want
      },
      before + 2,
      { timeout: 15000 },
    )
    if ((await attr('data-over')) === 'true') return
  }
}

try {
  await check('the dropdown offers Standard and all eight variants, with each rule', async () => {
    await openPlay()
    const options = await page.getByTestId('play-variant').locator('option').allTextContents()
    assert(options.join() === 'Standard,Crazyhouse,Chess960,King of the Hill,Three-Check,Antichess,Atomic,Horde,Racing Kings', options.join())
    await page.getByTestId('play-variant').locator('select').selectOption('atomic')
    assert(/Nuke your opponent/.test(await page.getByTestId('play-variant-rule').innerText()), 'wrong rule text')
    await shot('01-dropdown')
    return `${options.length} options`
  })

  await check('Panicfish is an opponent, with its description', async () => {
    await openPlay()
    const card = page.locator('.play-mode[data-bot="panicfish"]')
    await card.click()
    const text = await card.innerText()
    assert(/I am Stockfish 19 that loses 300 Elo every time you check me/.test(text), text)
    assert(/full 3600 grandmaster strength/.test(text), text)
    assert((await page.locator('.play-elo-slider').count()) === 0, 'it still has an Elo slider')
    assert(/random moves/.test(await page.getByTestId('play-panicfish-note').innerText()), 'no note about 0 Elo')
    await shot('02-panicfish-setup')
  })

  await check('without Fairy-Stockfish a variant says how to install it and cannot start', async () => {
    await page.route('**/api/health', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), fairy: { available: false, path: 'x' } } })
    })
    await openPlay({ variant: 'horde' })
    await page.getByTestId('play-fairy-install').waitFor({ timeout: 4000 })
    assert(/install_fairy\.py/.test(await page.getByTestId('play-fairy-install').innerText()), 'no command')
    assert(await page.getByTestId('play-start').isDisabled(), 'Start is enabled')
    await page.getByTestId('play-variant').locator('select').selectOption('chess960')
    await page.getByTestId('play-fairy-install').waitFor({ state: 'detached', timeout: 2000 })
    assert(await page.getByTestId('play-start').isEnabled(), 'Chess960 should only need Stockfish')
    await page.unroute('**/api/health')
  })

  await check('Maia and opening lines are standard chess only', async () => {
    await openPlay({ variant: 'atomic', bot: 'maia', useOpening: true })
    assert((await page.locator('.play-mode.active[data-bot="stockfish"]').count()) === 1, 'Maia still selected')
    await page.getByTestId('play-maia-standard-only').waitFor({ timeout: 2000 })
    assert((await page.getByText('Start from an opening line').count()) === 0, 'the opening toggle is still there')
    await page.getByTestId('play-variant').locator('select').selectOption('standard')
    assert((await page.locator('.play-mode.active[data-bot="maia"]').count()) === 1, 'the Maia choice did not come back')
  })

  await check('Panicfish is unavailable where there are no checks', async () => {
    for (const variant of ['antichess', 'racingkings']) {
      await openPlay({ variant, bot: 'panicfish' })
      assert((await page.locator('.play-mode.active[data-bot="stockfish"]').count()) === 1, `${variant}: still selected`)
      await page.getByTestId('play-panicfish-blocked').waitFor({ timeout: 2000 })
    }
  })

  await check('Horde against Panicfish keeps you on the side that can give check', async () => {
    await openPlay({ variant: 'horde', bot: 'panicfish', color: 'black' })
    await page.getByTestId('play-color-locked').waitFor({ timeout: 2000 })
    assert((await page.locator('[data-color="black"]').isDisabled()) === true, 'Black can still be chosen')
    await page.getByTestId('play-start').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.dataset.gameId, null, { timeout: 5000 })
    assert((await page.locator(BOARD).getAttribute('data-orientation')) === 'white', 'you are not the horde')
  })

  for (const [variant, firstMove] of [
    ['crazyhouse', 'e2e4'],
    ['kingofthehill', 'e2e4'],
    ['3check', 'e2e4'],
    ['antichess', 'e2e3'],
    ['atomic', 'e2e4'],
    ['horde', 'e4e5'],
    ['racingkings', 'h2h3'],
  ]) {
    await check(`${variant}: start position, a move and the engine's reply`, async () => {
      await realBot()
      await start({ variant, color: 'white', bot: 'stockfish', elo: 1500 })
      assert((await attr('data-variant')) === variant, `variant is ${await attr('data-variant')}`)
      const startFen = await fen()
      await play(firstMove)
      await waitPlies(2)
      const after = await fen()
      assert(after !== startFen, 'the position did not change')
      await page.getByTestId('play-variant-badge').waitFor({ timeout: 2000 })
      return (await page.locator('.play-moves').innerText()).replace(/\s+/g, ' ')
    })
  }

  await check('Chess960 draws a legal random position, and real Stockfish replies', async () => {
    await realBot()
    const seen = new Set()
    for (let i = 0; i < 4; i += 1) {
      await start({ variant: 'chess960', color: 'white', bot: 'stockfish', elo: 1500 })
      const rank = (await fen()).split('/')[0]
      seen.add(rank)
      const bishops = [...rank].flatMap((p, at) => (p === 'b' ? [at % 2] : []))
      const [rookA, king, rookB] = [rank.indexOf('r'), rank.indexOf('k'), rank.lastIndexOf('r')]
      assert(bishops[0] !== bishops[1], `bishops on one colour: ${rank}`)
      assert(rookA < king && king < rookB, `king not between rooks: ${rank}`)
    }
    assert(seen.size > 1, 'the same position every time')
    await play('e2e3')
    await waitPlies(2)
    return [...seen].join(' ')
  })

  await check('Chess960 castling works by moving the king onto its rook', async () => {
    const seen = await scriptBot(['a7a6'])
    const fen960 = 'bbqnrk1r/pppppppp/8/8/8/8/PPPPPPPP/BBQNRK1R w KQkq - 0 1'
    await resume({ variant: 'chess960', startFen: fen960 })
    await play('f1h1')
    await waitPlies(2)
    assert((await fen()).split(' ')[0].endsWith('/BBQNRRK1'), await fen())
    assert((await page.locator('.play-moves').innerText()).includes('O-O'), 'not written as O-O')
    assert(seen[0].variant === 'chess960', 'the variant was not sent')
  })

  await check('King of the Hill: reaching the center wins', async () => {
    await scriptBot(['a7a6', 'a6a5', 'a5a4'])
    await start({ variant: 'kingofthehill', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'e1e2', 'e2d3', 'd3d4'])
    await waitOver()
    assert(/You won by reaching the center/.test(await status()), await status())
    await closeOverDialog()
    assert((await page.getByTestId('play-review').count()) === 0, 'offers a review of a variant game')
    await shot('03-king-of-the-hill')
  })

  await check('Three-Check: the counter runs and the third check wins', async () => {
    await scriptBot(['d7d5', 'c7c6', 'b8c6', 'a7a6'])
    await start({ variant: '3check', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'f1b5', 'b5c6'])
    assert(/White 2 of 3, Black 0 of 3/.test(await page.getByTestId('play-checks').innerText()), await page.getByTestId('play-checks').innerText())
    await playLine(['d1h5', 'h5f7'])
    await waitOver()
    assert(/You won by giving three checks/.test(await status()), await status())
  })

  await check('Atomic: a capture next to the king blows it up', async () => {
    await scriptBot(['a7a6', 'a6a5'])
    await start({ variant: 'atomic', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'd1h5', 'h5f7'])
    await waitOver()
    assert(/You won by blowing up the king/.test(await status()), await status())
    assert(!(await fen()).split(' ')[0].includes('k'), 'the black king is still there')
  })

  await check('Antichess: a capture is forced, and losing everything wins', async () => {
    await scriptBot([])
    await resume({ variant: 'antichess', startFen: '8/8/8/8/8/1p6/P7/8 w - - 0 1' })
    assert((await attr('data-variant')) === 'antichess', 'not resumed')
    await play('a2a3')
    await page.waitForTimeout(250)
    assert((await plies()) === 0, 'a non-capture was allowed')
    await scriptBot([])
    await resume({ variant: 'antichess', startFen: '8/8/8/8/8/1P6/p7/8 b - - 0 1', studentColor: 'black' })
    await play('a2a1')
    await page.locator('.board-promo button[data-piece="k"]').waitFor({ timeout: 2000 })
    assert((await page.locator('.board-promo button').count()) === 5, 'no king to promote to')
    await page.locator('.board-promo button[data-piece="k"]').click()
    await waitPlies(1)
    assert((await fen()).startsWith('8/8/8/8/8/1P6/8/k7') , await fen())
    await scriptBot(['a2b3'])
    await resume({ variant: 'antichess', startFen: '8/8/8/8/8/1p6/P7/8 w - - 0 1', studentColor: 'black' })
    await waitOver()
    assert(/You won by losing every piece/.test(await status()), await status())
  })

  await check('Horde: capturing every pawn wins for Black', async () => {
    await scriptBot([])
    await resume({ variant: 'horde', startFen: '4k3/8/8/8/8/8/8/P1q5 b - - 0 1', studentColor: 'black' })
    await play('c1a1')
    await waitOver()
    assert(/You won by capturing the whole horde/.test(await status()), await status())
  })

  await check('Racing Kings: Black gets one move to catch up, then the race is over', async () => {
    await scriptBot([])
    await resume({ variant: 'racingkings', startFen: '8/6K1/k7/8/8/8/8/8 w - - 0 1' })
    await play('g7g8')
    await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.dataset.plies === '1', null, { timeout: 4000 })
    assert((await attr('data-over')) === 'true', 'Black was too far away to catch up, so White has won')
    assert(/You won by reaching the last rank/.test(await status()), await status())
  })

  await check('Crazyhouse: a captured piece goes in the pocket and can be clicked onto the board', async () => {
    await scriptBot(['d7d5', 'd8d5', 'b8c6'])
    await start({ variant: 'crazyhouse', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'e4d5'])
    const pawn = page.locator('[data-testid="play-pocket-white"] [data-role="pawn"]')
    await pawn.waitFor({ timeout: 2000 })
    assert((await pawn.getAttribute('data-count')) === '1', 'one pawn in the pocket')
    await pawn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="play-pocket-white"] [data-role="pawn"].armed'), null, { timeout: 2000 })
    await clickSquare('d4')
    await waitPlies(6)
    assert((await fen()).split('/')[4].includes('P'), await fen())
    assert((await page.locator('.play-moves').innerText()).includes('@d4'), await page.locator('.play-moves').innerText())
    assert((await page.locator('[data-testid="play-pocket-white"] [data-role="pawn"]').count()) === 0, 'the pawn is still in the pocket')
    await shot('04-crazyhouse-drop')
  })

  await check('Crazyhouse: a pocket piece can be dragged, an occupied square refuses it, and the bot can drop', async () => {
    await scriptBot(['b8c6', 'P@h3'])
    await resume({
      variant: 'crazyhouse',
      startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Np] w KQkq - 0 1',
    })
    const knight = page.locator('[data-testid="play-pocket-white"] [data-role="knight"]')
    await knight.waitFor({ timeout: 3000 })
    const box = await knight.boundingBox()
    const drag = async (square) => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(...(await squareAt(square)), { steps: 6 })
      await page.mouse.up()
    }
    await drag('e2')
    await page.waitForTimeout(200)
    assert((await plies()) === 0, 'dropped onto an occupied square')
    assert(((await fen()).split('/')[6]) === 'PPPPPPPP', await fen())
    await drag('f4')
    await waitPlies(2)
    assert((await fen()).split('/')[4].includes('N'), await fen())
    await playLine(['g1f3'])
    assert((await fen()).split('/')[5].includes('p'), await fen())
    assert((await page.locator('.play-moves').innerText()).includes('@h3'), await page.locator('.play-moves').innerText())
  })

  await check('Panicfish: a check costs 300 Elo, the next request uses it, and a takeback restores it', async () => {
    const seen = await scriptBot(['f7f6', 'g7g6', 'g8h6', 'h8g8'])
    await start({ variant: 'standard', color: 'white', bot: 'panicfish' })
    assert((await attr('data-bot-elo')) === '3600', await attr('data-bot-elo'))
    assert(/Full strength/.test(await page.getByTestId('play-strength').innerText()), await page.getByTestId('play-strength').innerText())
    await play('e2e4')
    await waitPlies(2)
    assert(seen[0].bot === 'panicfish' && seen[0].elo === 3600, JSON.stringify(seen[0]))
    await play('d1h5')
    await waitPlies(4)
    assert(seen[1].elo === 3300, `asked at ${seen[1].elo}`)
    assert((await attr('data-bot-elo')) === '3300', await attr('data-bot-elo'))
    assert((await page.getByTestId('play-elo-badge').innerText()) === '3300', 'the badge')
    assert((await page.getByTestId('play-bar-bot').innerText()).includes('3300'), 'the name plate')
    await shot('05-panicfish-3300')
    await page.locator('.play-toolbar button', { hasText: 'Takeback' }).click()
    await waitPlies(2)
    assert((await attr('data-bot-elo')) === '3600', 'takeback did not restore it')
  })

  await check('Panicfish counts only your checks, not its own', async () => {
    await scriptBot(['d7d5', 'c8g4'])
    await resume({
      bot: 'panicfish',
      elo: 3600,
      variant: 'standard',
      startFen: '4k3/8/8/8/8/8/3r4/4K2R b K - 0 1',
      studentColor: 'white',
      sans: ['Rd1+', 'Kxd1'],
    })
    assert((await attr('data-bot-elo')) === '3600', await attr('data-bot-elo'))
  })

  await check('Panicfish at 0 Elo: the real backend answers with a random move', async () => {
    await realBot()
    // twelve rook checks, with a pawn push between them so no position can repeat
    const startFen = '6k1/8/8/8/8/K7/PPPP4/7R w - - 0 1'
    const chess = new Chess(startFen)
    const sans = []
    const kingSteps = (a, b) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])))
    const blackKing = () => chess.findPiece({ type: 'k', color: 'b' })[0]
    const moveOr = (found, what) => {
      if (!found) throw new Error(`the seed game has no ${what}`)
      sans.push(chess.move(found).san)
    }
    // towards the middle, so the rook never traps the king before the twelfth check
    const edgeness = (sq) => Math.abs(sq.charCodeAt(0) - 100.5) + Math.abs(Number(sq[1]) - 4.5)
    const replyWithKing = () =>
      moveOr(
        chess
          .moves({ verbose: true })
          .filter((m) => m.piece === 'k' && !m.captured)
          .sort((x, y) => edgeness(x.to) - edgeness(y.to))[0],
        'king reply',
      )
    const pushPawn = () => {
      moveOr(chess.moves({ verbose: true }).find((m) => m.piece === 'p' && !m.promotion && !m.san.endsWith('+')), 'pawn push')
      replyWithKing()
    }
    for (let checks = 0; ; ) {
      const safeCheck = chess.moves({ verbose: true }).find((m) => m.piece === 'r' && m.san.endsWith('+') && !m.captured && kingSteps(m.to, blackKing()) > 1)
      if (!safeCheck) {
        pushPawn()
        continue
      }
      moveOr(safeCheck, 'rook check')
      checks += 1
      if (checks === 12) break // Black's reply is left for the bot
      replyWithKing()
      pushPawn()
    }
    await resume({ bot: 'panicfish', elo: 3600, variant: 'standard', startFen, sans })
    assert((await attr('data-bot-elo')) === '0', await attr('data-bot-elo'))
    assert(/random moves/.test(await page.getByTestId('play-strength').innerText()), await page.getByTestId('play-strength').innerText())
    await waitPlies(sans.length + 1)
    await shot('06-panicfish-broken')
    return `12 checks in ${sans.length} plies`
  })

  await check('real Stockfish plays Panicfish at full strength', async () => {
    await realBot()
    await start({ variant: 'standard', color: 'black', bot: 'panicfish', movetimeMs: 300 })
    await waitPlies(1)
    assert(/Full strength/.test(await page.getByTestId('play-strength').innerText()), 'not at full strength')
  })

  await check('History keeps variant games, without Review or Analyze', async () => {
    await scriptBot(['a7a6', 'a6a5', 'a5a4'])
    await start({ variant: 'kingofthehill', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'e1e2', 'e2d3', 'd3d4'])
    await waitOver()
    await closeOverDialog()
    await page.getByTestId('nav-more').click().catch(() => {})
    await page.getByRole('button', { name: 'History', exact: true }).click()
    const row = page.locator('[data-testid="history-row"][data-variant="kingofthehill"]').first()
    await row.waitFor({ timeout: 3000 })
    assert((await row.innerText()).includes('King of the Hill'), await row.innerText())
    assert((await row.getByTestId('history-review').count()) === 0, 'offers a review')
    assert((await row.getByTestId('history-analyze').count()) === 0, 'offers analysis')
    await row.click()
    await page.waitForTimeout(150)
    assert(await page.getByTestId('history-tab').isVisible(), 'the row navigated away')
    await shot('07-history')
  })

  await check('History records where Panicfish ended up, and standard games can still be reviewed', async () => {
    await page.evaluate((key) => localStorage.removeItem(key), HISTORY_KEY)
    await scriptBot(['f7f6', 'g7g6'])
    await start({ variant: 'standard', color: 'white', bot: 'panicfish' })
    await playLine(['e2e4', 'd1h5'])
    await page.locator('.play-toolbar button', { hasText: 'Resign' }).click()
    await page.getByTestId('play-resign-confirm').click()
    await waitOver()
    await page.getByTestId('play-over-review').waitFor({ timeout: 4000 })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'History', exact: true }).click()
    const row = page.locator('[data-testid="history-row"][data-bot="panicfish"]').first()
    await row.waitFor({ timeout: 3000 })
    assert(/Panicfish/.test(await row.innerText()) && /\(3300\)/.test(await row.innerText()), await row.innerText())
    assert((await row.getByTestId('history-review').count()) === 1, 'no Review button')
  })

  await check('Rematch keeps the variant', async () => {
    await scriptBot(['a7a6', 'a6a5', 'a5a4', 'd2d4'])
    await start({ variant: 'kingofthehill', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4', 'e1e2', 'e2d3', 'd3d4'])
    await waitOver()
    await page.getByTestId('play-over-rematch').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="play-tab"]')?.dataset.over === 'false', null, { timeout: 4000 })
    assert((await attr('data-variant')) === 'kingofthehill', await attr('data-variant'))
  })

  await check('a variant game survives a reload', async () => {
    await scriptBot(['d7d5'])
    await start({ variant: 'crazyhouse', color: 'white', bot: 'stockfish', elo: 1500 })
    await playLine(['e2e4'])
    const before = await fen()
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await tab().waitFor()
    assert((await attr('data-variant')) === 'crazyhouse', await attr('data-variant'))
    assert((await fen()) === before, `${await fen()} vs ${before}`)
  })

  await check('a standard game still has Hint and no variant badge', async () => {
    await realBot()
    await start({ variant: 'standard', color: 'white', bot: 'stockfish', elo: 1200 })
    assert((await page.locator('.play-toolbar button', { hasText: 'Hint' }).count()) === 1, 'no Hint')
    assert((await page.getByTestId('play-variant-badge').count()) === 0, 'a variant badge on standard chess')
    await play('e2e4')
    await waitPlies(2)
    assert((await fen()).split(' ')[1] === 'w', 'not your move')
  })

  await check('no console errors', async () => {
    assert(errors.length === 0, errors.slice(0, 3).join(' | '))
  })
} finally {
  await browser.close()
  console.log(`\n${total - failed}/${total} checks passed; screenshots in ${SHOTS}`)
  process.exitCode = failed ? 1 : 0
}
