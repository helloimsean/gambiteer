// First: registers the phone's translations before any module calls t() at load time.
import './phoneLanguage'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'
import '@frontend/styles/theme.css'
import { MobileApp } from './MobileApp'
// After MobileApp, so these overrides come later in the bundle than every tab's own stylesheet.
import './mobile.css'
import './tabs/learn.css'
import './tabs/quiz.css'
import './tabs/analyze.css'
import './tabs/play.css'
import './tabs/review.css'
import { installNativeHooks } from './native'

installNativeHooks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
)
