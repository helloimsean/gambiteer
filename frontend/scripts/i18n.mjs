// Translation catalogs (src/i18n/<code>.json) against the t() / tn() calls in the code.
//
//   node scripts/i18n.mjs                      check every catalog: missing, unused, broken placeholders
//   node scripts/i18n.mjs --keys out.json      write every key (with plural info) for translating
//   node scripts/i18n.mjs --src ../mobile/web/src --src src --patches ../mobile/web/text-patches.mjs //        --base src/i18n --catalogs ../mobile/web/src/i18n
//                                              the phone app (npm run check:i18n:mobile): its own
//                                              sources plus the shared ones as the phone build patches
//                                              them, counting what src/i18n already translates
//
// Keys are the English texts. A plural (tn) is keyed by its English plural form and translated as
// an object of CLDR plural forms ({ "one": ..., "few": ..., "many": ..., "other": ... }).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const every = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const fromFrontend = (p) => path.resolve(here, '..', p)
const srcDirs = (every('--src').length ? every('--src') : ['src']).map(fromFrontend)
const catalogDir = fromFrontend(option('--catalogs', 'src/i18n'))
const baseDir = option('--base', null) && fromFrontend(option('--base'))
const keysOut = option('--keys', null)
// a module exporting PATCH_ROOT and applyTextPatches(relativePath, code, onMiss), as the phone build has
const patcher = option('--patches', null) && (await import(pathToFileURL(fromFrontend(option('--patches'))).href))

const LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*?)\1`
const T_CALL = new RegExp(String.raw`(?<![\w.$])t\(\s*` + LITERAL, 'g')
const TN_CALL = new RegExp(String.raw`(?<![\w.$])tn\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*` + LITERAL + String.raw`\s*,\s*` + LITERAL.replaceAll('\\1', '\\3'), 'g')
const ANY_T = /(?<![\w.$])t\(\s*([^'"`\s)][^,)]*)/g
const ANY_TN = /(?<![\w.$])tn\([^,]+,\s*([^'"`\s][^,)]*)/g

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c)
const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!['i18n', 'dev', 'node_modules'].includes(name)) yield* sources(full)
    } else if (/\.(tsx?|mjs)$/.test(name) && !/\.(e2e|check|test)\./.test(name) && name !== 'i18n.ts') {
      yield full
    }
  }
}

const keys = new Map() // key -> { plural?: one-form, files: Set }
const problems = []
const files = srcDirs.flatMap((dir) => [...sources(dir)].map((file) => ({ file, dir })))
for (const { file, dir } of files) {
  let code = readFileSync(file, 'utf8')
  const rel = path.relative(dir, file)
  if (patcher) {
    const fromRoot = path.relative(patcher.PATCH_ROOT, file).split(path.sep).join('/')
    const patched = patcher.applyTextPatches(fromRoot, code, (from) => problems.push(`${rel}: text patch no longer matches: ${from}`))
    if (patched !== null) code = patched
  }
  const add = (key, one) => {
    const entry = keys.get(key) ?? { files: new Set() }
    if (one !== undefined) entry.one = one
    entry.files.add(rel)
    keys.set(key, entry)
  }
  for (const m of code.matchAll(TN_CALL)) {
    if (m[1] === '`' && m[2].includes('${')) problems.push(`${rel}: tn() with \${...} inside: ${m[2]}`)
    add(unescape(m[4]), unescape(m[2]))
  }
  for (const m of code.matchAll(T_CALL)) {
    if (m[1] === '`' && m[2].includes('${')) problems.push(`${rel}: t() with \${...} inside (use a {placeholder}): ${m[2]}`)
    else add(unescape(m[2]))
  }
  for (const m of [...code.matchAll(ANY_T), ...code.matchAll(ANY_TN)]) {
    problems.push(`${rel}: t()/tn() of a non-literal, so its text is never translated: ${m[0].slice(0, 70)}`)
  }
}
// tn's first argument may hold a call with commas; anything its regex missed shows up here
for (const key of keys.keys()) if (!key.trim()) keys.delete(key)

if (keysOut) {
  const list = [...keys].sort(([a], [b]) => a.localeCompare(b)).map(([key, e]) => ({ key, ...(e.one !== undefined ? { plural: true, one: e.one } : {}), files: [...e.files].map((f) => f.split(path.sep).join('/')) }))
  writeFileSync(path.resolve(keysOut), JSON.stringify(list, null, 2) + '\n')
  console.log(`${list.length} keys (${list.filter((k) => k.plural).length} plural) written to ${keysOut}`)
}

let failures = 0
const catalogs = readdirSync(catalogDir).filter((f) => /^[a-z]{2}\.json$/.test(f))
for (const name of catalogs) {
  const catalog = JSON.parse(readFileSync(path.join(catalogDir, name), 'utf8'))
  const base = baseDir ? JSON.parse(readFileSync(path.join(baseDir, name), 'utf8')) : {}
  const missing = [...keys.keys()].filter((k) => !(k in catalog) && !(k in base))
  const unused = Object.keys(catalog).filter((k) => !keys.has(k))
  const broken = []
  for (const [key, entry] of keys) {
    const value = catalog[key] ?? base[key]
    if (value === undefined) continue
    const allowed = placeholders(key)
    if (entry.one !== undefined) {
      allowed.add('n')
      for (const p of placeholders(entry.one)) allowed.add(p)
      if (typeof value === 'string') continue // one form for every count is allowed
      if (!value || typeof value !== 'object' || typeof value.other !== 'string') {
        broken.push(`${key}: a plural needs an object with at least "other"`)
        continue
      }
      for (const [form, text] of Object.entries(value)) {
        for (const p of placeholders(text)) if (!allowed.has(p)) broken.push(`${key} [${form}]: unknown {${p}}`)
      }
    } else {
      if (typeof value !== 'string') {
        broken.push(`${key}: should be a string`)
        continue
      }
      const got = placeholders(value)
      for (const p of allowed) if (!got.has(p)) broken.push(`${key}: lost {${p}}`)
      for (const p of got) if (!allowed.has(p)) broken.push(`${key}: unknown {${p}}`)
    }
  }
  const ok = missing.length === 0 && broken.length === 0
  if (!ok) failures++
  console.log(`${name}: ${keys.size - missing.length}/${keys.size} translated, ${missing.length} missing, ${unused.length} unused, ${broken.length} broken`)
  for (const b of broken.slice(0, 20)) console.log(`   broken: ${b}`)
  for (const m of missing.slice(0, 8)) console.log(`   missing: ${m}`)
}
for (const p of problems) console.log(`code: ${p}`)
console.log(`${keys.size} keys in ${srcDirs.map((d) => path.relative(process.cwd(), d) || '.').join(' + ')}`)
process.exit(failures || problems.length ? 1 : 0)
