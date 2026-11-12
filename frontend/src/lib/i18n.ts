/**
 * The app's language. The English text is the key: `t('Step through the moves')` looks it up in the
 * current language's catalog (src/i18n/<code>.json) and falls back to the English when missing.
 *
 *   t('Saved {name} to Downloads', { name })   placeholders in braces
 *   tn(count, '{n} move', '{n} moves')          plurals: {n} is the count; the catalog keys the
 *                                               English plural and gives each plural form, e.g.
 *                                               "{n} moves": { "one": "{n} ход", "few": "{n} хода",
 *                                               "many": "{n} ходов", "other": "{n} хода" }
 *
 * The language is read once at startup, and choosing another one reloads the page, so text built at
 * module level or inside useMemo is always in the current language.
 */
import de from '../i18n/de.json'
import es from '../i18n/es.json'
import fr from '../i18n/fr.json'
import it from '../i18n/it.json'
import pt from '../i18n/pt.json'
import ru from '../i18n/ru.json'
import zh from '../i18n/zh.json'

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português' },
  { code: 'it', name: 'Italiano' },
  { code: 'zh', name: '中文' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>
type Catalog = Record<string, string | PluralForms>

const CATALOGS: Partial<Record<LanguageCode, Catalog>> = { de, es, fr, it, pt, ru, zh }
const extra: Partial<Record<LanguageCode, Catalog>> = {}

export const LANGUAGE_KEY = 'language-v1'

function isLanguage(code: string): code is LanguageCode {
  return LANGUAGES.some((l) => l.code === code)
}

/** The saved choice, else the browser's (or phone's) language when the app has it, else English. */
function startLanguage(): LanguageCode {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_KEY)
    if (saved && isLanguage(saved)) return saved
  } catch {
    /* storage blocked: fall through */
  }
  const tags = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of tags) {
    const base = (tag ?? '').toLowerCase().split('-')[0]
    if (isLanguage(base)) return base
  }
  return 'en'
}

const current: LanguageCode = startLanguage()
if (typeof document !== 'undefined') document.documentElement.lang = current
let pluralRules: Intl.PluralRules | null = null

export function getLanguage(): LanguageCode {
  return current
}

/** Saves the choice and reloads the app in that language. */
export function setLanguage(code: LanguageCode): void {
  if (code === current) return
  try {
    window.localStorage.setItem(LANGUAGE_KEY, code)
  } catch {
    return
  }
  window.location.reload()
}

/** More messages for a language, from code outside src (the phone app's own screens). */
export function addMessages(code: LanguageCode, messages: Catalog): void {
  extra[code] = { ...extra[code], ...messages }
}

function lookup(text: string): string | PluralForms | undefined {
  if (current === 'en') return undefined
  return extra[current]?.[text] ?? CATALOGS[current]?.[text]
}

function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** `text` in the current language. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const found = lookup(text)
  return fill(typeof found === 'string' && found ? found : text, vars)
}

/** `one` or `other` (English) in the current language's plural form for `count`, which fills {n}. */
export function tn(count: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const values = { n: count, ...vars }
  const found = lookup(other)
  if (found && typeof found === 'object') {
    pluralRules ??= new Intl.PluralRules(current)
    const form = found[pluralRules.select(count)] ?? found.other
    if (form) return fill(form, values)
  } else if (typeof found === 'string' && found) {
    return fill(found, values)
  }
  return fill(count === 1 ? one : other, values)
}
