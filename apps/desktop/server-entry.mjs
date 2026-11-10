// atento desktop sidecar server.
//
// Self-contained backend for the packaged Electrobun app: wires the same
// composition root as `atento serve` (createAtento + startServer +
// optional /mcp) but takes uiDist explicitly so the built UI can live
// next to this file inside the app bundle.
//
// Env:
//   ATENTO_PORT      listen port (default 4173)
//   ATENTO_UI_DIST   directory with the built ui (default ./ui-dist)
//   ATENTO_HOST      bind host (default 127.0.0.1)
//   ATENTO_DATA_DIR  atento data dir override (via config env)

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createAtento,
	disposeLogging,
	loadConfig,
	pipelineLogger,
	setupLogging,
} from '@atento/app'
import { startServer } from '@atento/server'

const env = process.env
const here = dirname(fileURLToPath(import.meta.url))
const port = Number(env['ATENTO_PORT'] ?? '') || 4173
const hostname = env['ATENTO_HOST'] ?? '127.0.0.1'
const uiDist = env['ATENTO_UI_DIST'] ?? join(here, 'ui-dist')

const config = loadConfig(env)
const logger = pipelineLogger('desktop')
const app = await createAtento(config, { env, logger })
setupLogging({ console: true })

let mcpFetch
try {
	const mcp = await import('@atento/mcp')
	if (typeof mcp.createMcpHttpHandler === 'function' && typeof mcp.createMcpDeps === 'function') {
		const handler = mcp.createMcpHttpHandler(mcp.createMcpDeps(app, logger))
		mcpFetch = (request) => handler.fetch(request)
	}
} catch {
	// @atento/mcp absent: serve api/ui without /mcp.
}

const server = await startServer({
	port,
	hostname,
	store: app.store,
	ops: app,
	config,
	capture: config.capture,
	server: config.server,
	env,
	uiDist,
	...(mcpFetch !== undefined ? { mcpFetch } : {}),
})

console.log(`[atento-server] serving on http://${hostname}:${server.port}`)

let closing = false
async function shutdown() {
	if (closing) return
	closing = true
	try {
		await server.close()
	} finally {
		await app.close()
		disposeLogging()
		process.exit(0)
	}
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// Parent watchdog: the Electrobun shell can exit without running JS `exit`
// handlers (crash, force-quit, OS logout), which would orphan this sidecar
// on 127.0.0.1:4173. When spawned by the shell it passes its pid via
// ATENTO_PARENT_PID; if that process disappears, shut down gracefully.
const parentPid = Number(env['ATENTO_PARENT_PID'] ?? '') || 0
if (parentPid > 0 && parentPid !== process.pid) {
	const watchdog = setInterval(() => {
		try {
			process.kill(parentPid, 0)
		} catch (e) {
			if (e && e.code === 'ESRCH') {
				console.log('[atento-server] parent process exited, shutting down')
				void shutdown()
			}
		}
	}, 2000)
	watchdog.unref()
}
