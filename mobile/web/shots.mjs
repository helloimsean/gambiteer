// Phone-sized screenshots of every tab, against `node web/dev.mjs` and the PC backend.
//   node web/shots.mjs <output folder> [tab ...]
// Reports console errors and horizontal overflow, the two things a screenshot can hide.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.resolve(here, '../../frontend/package.json'))
const { chromium } = require('playwright')

const BASE = process.env.BASE ?? 'http://localhost:5180'
const out = path.resolve(process.argv[2] ?? 'shots')
const only = process.argv.slice(3)
fs.mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 412, height: 780 }, // S26 Ultra in CSS pixels, minus the status and gesture bars
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
// SHOT_LANG=ru node web/shots.mjs ...: the app in that language (Settings > Language)
if (process.env.SHOT_LANG) await context.addInitScript((code) => localStorage.setItem('language-v1', code), process.env.SHOT_LANG)
const page = await context.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`)
})

async function shot(name) {
  await page.waitForTimeout(500)
  const overflow = await page.evaluate(() => {
    const limit = window.innerWidth + 1
    const wide = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > limit && getComputedStyle(el).position !== 'fixed') {
        let scroller = el.parentElement
        let clipped = false
        while (scroller) {
          const overflowX = getComputedStyle(scroller).overflowX
          if (overflowX === 'auto' || overflowX === 'scroll') clipped = true
          scroller = scroller.parentElement
        }
        if (!clipped) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`)
      }
    }
    return wide.slice(0, 8)
  })
  await page.screenshot({ path: path.join(out, `${name}.png`) })
  console.log(`${name}: ${overflow.length ? `OVERFLOW ${overflow.join(', ')}` : 'ok'}`)
}

// By position, not by label, so the flows work in every app language.
const TAB_ORDER = ['Learn', 'Quiz', 'Analyze', 'Play', 'Review', 'History']
const tab = (label) => page.locator('.m-tab').nth(TAB_ORDER.indexOf(label)).click()

const flows = {
  learn: async () => {
    await tab('Learn')
    await shot('learn-gallery')
    await page.locator('.card.clickable, [data-testid^="learn-card"]').first().click()
    await page.waitForTimeout(800)
    await shot('learn-opening')
  },
  quiz: async () => {
    await tab('Quiz')
    await shot('quiz')
  },
  analyze: async () => {
    await tab('Analyze')
    await page.waitForTimeout(1500)
    await shot('analyze')
  },
  play: async () => {
    await tab('Play')
    await shot('play-setup')
  },
  review: async () => {
    await tab('Review')
    await shot('review-setup')
  },
  history: async () => {
    await tab('History')
    await shot('history')
  },
  settings: async () => {
    await page.locator('.m-top .btn-icon').click()
    await shot('settings')
    await page.keyboard.press('Escape')
  },
}

await page.goto(BASE)
await page.waitForSelector('.m-tab')
for (const [name, flow] of Object.entries(flows)) {
  if (only.length && !only.includes(name)) continue
  try {
    await flow()
  } catch (error) {
    problems.push(`${name} flow failed: ${error.message.split('\n')[0]}`)
  }
}
await browser.close()
console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join('\n')}` : 'no console errors')
