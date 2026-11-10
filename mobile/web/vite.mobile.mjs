// Vite settings for the phone build. The tabs, components and state come straight from
// ../../frontend/src; only the shell, a stylesheet and a few user-facing strings differ.
// There is one node_modules (frontend's), so the tools and packages are loaded from there.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const frontend = path.resolve(here, '../../frontend')
const modules = path.join(frontend, 'node_modules')

export const { build, createServer } = await import(pathToFileURL(path.join(modules, 'vite/dist/node/index.js')).href)
const { default: react } = await import(pathToFileURL(path.join(modules, '@vitejs/plugin-react/dist/index.js')).href)

const BACKEND = process.env.BACKEND ?? 'http://localhost:8000'

/** Desktop wording that would be wrong on a phone. The build fails if a target text disappears. */
const TEXT_PATCHES = {
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
      /Ollama is not running on this PC[\s\S]*?then retry\./,
      'No coach model is downloaded yet, so moves cannot be explained. The review itself still works. Get one in Settings (the gear at the top), then retry.',
    ],
  ],
}

function textPatches() {
  const src = `${frontend.replaceAll('\\', '/')}/src/`
  return {
    name: 'gambiteer-text-patches',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/')
      if (!file.startsWith(src)) return null
      const patches = TEXT_PATCHES[file.slice(src.length)]
      if (!patches) return null
      let result = code
      for (const [from, to] of patches) {
        const next = result.replace(from, to)
        if (next === result) this.error(`text patch no longer matches ${file}: ${from}`)
        result = next
      }
      return { code: result, map: null }
    },
  }
}

export function mobileConfig() {
  return {
    configFile: false,
    root: here,
    publicDir: path.join(frontend, 'public'),
    plugins: [textPatches(), react()],
    resolve: {
      alias: [
        { find: '@frontend', replacement: path.join(frontend, 'src') },
        { find: /^react$/, replacement: path.join(modules, 'react') },
        { find: /^react\/(.*)$/, replacement: path.join(modules, 'react/$1') },
        { find: /^react-dom$/, replacement: path.join(modules, 'react-dom') },
        { find: /^react-dom\/(.*)$/, replacement: path.join(modules, 'react-dom/$1') },
        { find: /^chessground\/(.*)$/, replacement: path.join(modules, 'chessground/$1') },
      ],
    },
    server: {
      port: 5180,
      strictPort: true,
      fs: { allow: [here, frontend] },
      proxy: {
        '/api': { target: BACKEND, changeOrigin: true },
        '/ws': { target: BACKEND, ws: true, changeOrigin: true },
      },
    },
    build: {
      outDir: path.join(here, 'dist'),
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  }
}
