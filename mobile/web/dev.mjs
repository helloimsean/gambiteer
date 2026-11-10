// Phone web app against the PC backend, for layout work: node web/dev.mjs  (http://localhost:5180)
import { createServer, mobileConfig } from './vite.mobile.mjs'

const server = await createServer(mobileConfig())
await server.listen()
server.printUrls()
