// Production build of the phone web app: node web/build.mjs
import { build, mobileConfig } from './vite.mobile.mjs'

await build(mobileConfig())
