// Vite settings for the phone build. The tabs, components and state come straight from
// ../../frontend/src; only the shell, a stylesheet and a few user-facing strings differ.
// There is one node_modules (frontend's), so the tools and packages are loaded from there.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyTextPatches } from './text-patches.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const frontend = path.resolve(here, '../../frontend')
const modules = path.join(frontend, 'node_modules')

export const { build, createServer } = await import(pathToFileURL(path.join(modules, 'vite/dist/node/index.js')).href)
const { default: react } = await import(pathToFileURL(path.join(modules, '@vitejs/plugin-react/dist/index.js')).href)

const BACKEND = process.env.BACKEND ?? 'http://localhost:8000'

/** Swaps desktop wording for phone wording (text-patches.mjs). */
function textPatches() {
  const src = `${frontend.replaceAll('\\', '/')}/src/`
  return {
    name: 'gambiteer-text-patches',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/')
      if (!file.startsWith(src)) return null
      const result = applyTextPatches(file.slice(src.length), code, (from) => this.error(`text patch no longer matches ${file}: ${from}`))
      return result === null ? null : { code: result, map: null }
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
