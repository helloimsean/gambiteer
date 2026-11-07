import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev server proxies the FastAPI backend (port 8000) so the browser only ever talks to :5173.
// `/api` carries JSON, `/ws` carries the WebSocket streams (analysis, review progress, explain).
// In production the backend serves `dist/` itself, so the same relative URLs keep working.
const BACKEND = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to 5174 (the backend's CORS list and the docs assume 5173).
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/ws': {
        target: BACKEND,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // chessground + chess.js + react are ~250 kB; no need for the default 500 kB warning noise
    chunkSizeWarningLimit: 900,
  },
})
