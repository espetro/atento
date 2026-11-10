#!/usr/bin/env node
/**
 * atento-harness — the service runner. `start` is a foreground process
 * (launchd/systemd keep it alive); `stop`/`status` use the pidfile under
 * the atento config dir; `install`/`uninstall` manage the supervisor
 * unit. Recurrence lives in harness.toml next to config.toml.
 */
import { Command } from 'commander'
import { loadConfig } from '@atento/app'
import { loadHarnessConfig } from './config.js'
import {
  harnessStatus,
  harnessPidPath,
  readPidFile,
  removePidFile,
  stopHarness,
  verifyHarnessPid,
} from './lifecycle.js'
import { installHarness, uninstallHarness } from './install.js'
import { startHarness, type HarnessRuntime } from './serve.js'

function env(): NodeJS.ProcessEnv {
  return process.env
}

async function cmdStart(options: { port?: string; hostname?: string }): Promise<void> {
  const e = env()
  const status = harnessStatus(e)
  if (status.running) {
    console.error(
      `atento-harness already running (pid ${status.pid}, ${status.url ?? 'unknown url'})`,
    )
    process.exitCode = 1
    return
  }
  if (status.stale === true) removePidFile(harnessPidPath(e))

  const config = loadConfig(e)
  const harness = loadHarnessConfig(e, config)
  const port = options.port !== undefined ? Number(options.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    console.error(`invalid --port: ${options.port}`)
    process.exitCode = 1
    return
  }

  let runtime: HarnessRuntime
  try {
    runtime = await startHarness({
      config,
      harness,
      env: e,
      ...(port !== undefined ? { port } : {}),
      ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    })
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  console.log(`atento-harness serving on ${runtime.url}`)
  if (runtime.webDir === null) {
    console.log('web UI not built — placeholder page served (see harness.toml web_dir)')
  } else {
    console.log(`web UI: ${runtime.webDir}`)
  }
  const recurrence = [
    harness.schedule !== undefined ? `cron "${harness.schedule}"` : undefined,
    harness.onIngest ? 'on_ingest' : undefined,
  ].filter(Boolean)
  console.log(
    recurrence.length > 0
      ? `recurrence: ${recurrence.join(' + ')}`
      : 'recurrence: none (set schedule / on_ingest in harness.toml)',
  )

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`atento-harness: ${signal}, shutting down`)
    void runtime
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function cmdStop(): Promise<void> {
  const result = await stopHarness({ env: env() })
  if (result.stopped) {
    console.log(`atento-harness stopped (pid ${result.pid})`)
  } else if (result.refused === true) {
    console.log(
      `atento-harness: pid ${result.pid} is alive but could not be verified ` +
        `as the harness (possible pid reuse) — nothing was signalled`,
    )
  } else if (result.pid !== undefined) {
    console.log(`atento-harness was not running (stale pidfile removed)`)
  } else {
    console.log('atento-harness is not running')
  }
}

async function cmdStatus(json: boolean): Promise<void> {
  const e = env()
  const status = harnessStatus(e)
  // Liveness says running — verify identity so a recycled pid doesn't
  // masquerade as the service.
  let verified = true
  if (status.running && status.pid !== undefined) {
    const info = readPidFile(harnessPidPath(e))
    if (info !== null) verified = await verifyHarnessPid(info)
  }
  if (json) {
    console.log(JSON.stringify({ ...status, verified }))
    return
  }
  if (status.running) {
    console.log(`atento-harness is running${verified ? '' : ' (pid identity unverified — possible pid reuse)'}`)
    console.log(`  pid:      ${status.pid}`)
    if (status.startedAt) console.log(`  started:  ${status.startedAt}`)
    if (status.url) console.log(`  url:      ${status.url}`)
    if (status.port) console.log(`  port:     ${status.port}`)
  } else if (status.stale === true) {
    console.log(`atento-harness is not running (stale pidfile for pid ${status.pid})`)
  } else {
    console.log('atento-harness is not running')
  }
}

async function cmdInstall(register: boolean): Promise<void> {
  const result = await installHarness({ env: env(), register })
  console.log(`unit written: ${result.unitPath}`)
  if (register) {
    if (result.registered) {
      console.log('registered with the service supervisor')
    } else {
      console.log('supervisor registration failed (unit file still installed):')
      for (const err of result.errors) console.log(`  ${err}`)
      console.log('start manually or re-run install once the supervisor is available')
    }
  } else {
    console.log('registration skipped (--no-register)')
  }
}

async function cmdUninstall(register: boolean): Promise<void> {
  // Stop a running instance first so nothing keeps the deleted unit alive.
  const stop = await stopHarness({ env: env() })
  if (stop.stopped) console.log(`stopped running harness (pid ${stop.pid})`)
  const result = await uninstallHarness({ env: env(), register })
  if (result.removed) {
    console.log(`removed: ${result.unitPath}`)
  } else {
    console.log(`no unit file at ${result.unitPath}`)
  }
  for (const err of result.errors) console.log(`warning: ${err}`)
}

export function createProgram(): Command {
  const program = new Command()
  program
    .name('atento-harness')
    .description('atento service runner: lifecycle, recurrence, notifications, web serving')

  program
    .command('start')
    .description('run the harness in the foreground (serves api + web ui)')
    .option('--port <port>', 'port to bind (default ATENTO_PORT or 4173)')
    .option('--hostname <host>', 'bind hostname (default ATENTO_HOST or 127.0.0.1)')
    .action(async (options: { port?: string; hostname?: string }) => {
      try {
        await cmdStart(options)
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
    })

  program
    .command('stop')
    .description('stop the running harness (SIGTERM, then SIGKILL after 10s)')
    .action(async () => {
      try {
        await cmdStop()
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
    })

  program
    .command('status')
    .description('show whether the harness is running')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      try {
        await cmdStatus(options.json === true)
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
    })

  program
    .command('install')
    .description('register a launchd agent (macOS) or systemd user unit (Linux)')
    .option('--no-register', 'write the unit file but skip supervisor registration')
    .action(async (options: { register?: boolean }) => {
      try {
        await cmdInstall(options.register !== false)
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
    })

  program
    .command('uninstall')
    .description('remove the supervisor unit and stop the harness')
    .option('--no-register', 'only remove files; skip supervisor unregistration')
    .action(async (options: { register?: boolean }) => {
      try {
        await cmdUninstall(options.register !== false)
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
    })

  return program
}

// Entry point: this module is the bin (dist/bin.js). Top-level await keeps
// the process alive for `start` until shutdown completes.
const program = createProgram()
try {
  await program.parseAsync(process.argv)
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
