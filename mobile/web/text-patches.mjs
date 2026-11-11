// Desktop wording that would be wrong on a phone, swapped in when the phone build compiles
// ../../frontend/src (see vite.mobile.mjs). The build fails if a target text disappears.
//
// Most targets sit inside t('...'), so the phone text becomes the translation key: its
// translations live in src/i18n/<code>.json. Check them with
//   node ../../frontend/scripts/i18n.mjs --src ../mobile/web/src --src src --patches ../mobile/web/text-patches.mjs --base src/i18n --catalogs ../mobile/web/src/i18n
// (run from frontend/; `npm run check:i18n:mobile` there does the same).
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The folder the patch paths below are relative to. */
export const PATCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src')

export const TEXT_PATCHES = {
  'tabs/Learn/learnCoach.ts': [
    ['Coach unavailable: the selected Ollama model is not installed.', 'Coach unavailable: that coach model is not downloaded.'],
    ['Coach unavailable (is Ollama running?)', 'Coach unavailable: download a coach model in Settings (the gear at the top).'],
  ],
  'tabs/Learn/LearnCoachCard.tsx': [['a local AI model (Ollama)', 'an AI model on this phone (Gemma)']],
  'tabs/Learn/LearnPracticeMenu.tsx': [['Ask the Ollama coach', 'Ask the coach']],
  'tabs/Analyze/AnalyzeImportPanel.tsx': [['<span className="dim small">Ctrl+Enter</span>', '']],
  'tabs/Review/ReviewModelPicker.tsx': [
    ['Checking Ollama…', 'Checking the coach…'],
    ['Ollama model used for explanations', 'Coach model used for explanations'],
    ['Explanations need Ollama', 'Explanations need the coach'],
    [
      'Ollama is not running (or has no models), so the coach is offline. Start Ollama, then retry.',
      'No coach model is downloaded yet. Get one in Settings (the gear at the top), then retry.',
    ],
    [
      /\{t\(\s*'Ollama is not running on this PC[\s\S]*?\{t\(', then retry\.'\)\}/,
      "{t('No coach model is downloaded yet, so moves cannot be explained. The review itself still works. Get one in Settings (the gear at the top), then retry.')}",
    ],
  ],
}

/** Apply the patches for one file (its path relative to PATCH_ROOT, with forward slashes). */
export function applyTextPatches(relativePath, code, onMiss) {
  const patches = TEXT_PATCHES[relativePath]
  if (!patches) return null
  let result = code
  for (const [from, to] of patches) {
    const next = result.replace(from, to)
    if (next === result) onMiss(from)
    result = next
  }
  return result
}
