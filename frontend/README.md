# Gambiteer: frontend

Vite 8 + React 19 + TypeScript (strict), chessground 9 (board), chess.js 1.4 (rules). No UI
framework, no router: `src/App.tsx` holds the active tab.

```
npm install
npm run dev            # http://localhost:5173 (proxies /api and /ws to the backend on :8000)
npm run build          # tsc -b + vite build into dist/ (the backend serves dist/ in production)
npm run check:board    # Playwright smoke test of the shell and the Board (needs `npm run dev`)
npm run lint           # oxlint
```

* http://localhost:5173/?dev=1 is the component playground: every shared component with fake data,
  no backend needed.
* `src/tabs/README.md` is the guide for implementing the tabs (AppContext, Board, API client,
  WebSocket helpers, layout and file ownership).
* `../ARCHITECTURE.md` holds the binding contracts (endpoints, JSON shapes, look and feel).

Layout of `src/`:

```
api/         types.ts (every JSON contract), client.ts (HTTP + WebSocket helpers)
components/  Board, EvalBar, MoveList, EngineLines, OpeningTree, ClassificationBadge, Modal,
             Select, Toggle, Slider, Spinner, EmptyState, Icon
lib/         chess.ts, eval.ts, tree.ts, sounds.ts, storage.ts, dom.ts
state/       AppContext.tsx (active tab, cross-tab requests, settings, last game, health)
styles/      theme.css (palette variables, base styles, buttons, panels, inputs, badges, board theme)
tabs/        Learn/ Quiz/ Analyze/ Play/ Review/ (one folder per tab)
dev/         DevPlayground (?dev=1), fixture opening, fake data
```
