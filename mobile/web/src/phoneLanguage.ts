/**
 * The phone's own translations: the shell (MobileApp, CoachModels, native) and the phone wording
 * swapped into the shared tabs by text-patches.mjs. The shared tabs' texts come from
 * frontend/src/i18n. main.tsx imports this module first, before any module that calls t().
 */
import { addMessages, getLanguage, type LanguageCode } from '@frontend/lib/i18n'
import de from './i18n/de.json'
import es from './i18n/es.json'
import fr from './i18n/fr.json'
import it from './i18n/it.json'
import pt from './i18n/pt.json'
import ru from './i18n/ru.json'
import zh from './i18n/zh.json'

const PHONE_CATALOGS = { de, es, fr, it, pt, ru, zh }
for (const [code, messages] of Object.entries(PHONE_CATALOGS)) addMessages(code as LanguageCode, messages)

// Android's own texts (the start screen, download notifications) follow the app's language.
try {
  window.GambiteerNative?.setLanguage(getLanguage())
} catch (error) {
  console.error('setLanguage', error)
}
