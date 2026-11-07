/**
 * Native notifications after each harness run. The Notifier is a port: the
 * platform implementation shells out to terminal-notifier/osascript on
 * macOS and notify-send on Linux, and every failure degrades silently —
 * a missing notifier binary must never break a run.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HarnessRunRecord } from './runs.js'

const execFileAsync = promisify(execFile)

export interface NotificationRequest {
  title: string
  body: string
  /** Deep link back to the UI; used where the platform supports it. */
  url?: string
}

export interface Notifier {
  notify(request: NotificationRequest): Promise<void>
}

/** Injectable exec: resolves on exit 0, rejects otherwise. */
export type ExecFn = (file: string, args: string[]) => Promise<unknown>

export const defaultExec: ExecFn = async (file, args) => {
  await execFileAsync(file, args)
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
function applescriptQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function notifyDarwin(
  req: NotificationRequest,
  exec: ExecFn,
): Promise<void> {
  // terminal-notifier supports a real click-through URL; prefer it when the
  // binary exists, fall back to osascript's display notification.
  try {
    const args = ['-title', req.title, '-message', req.body]
    if (req.url !== undefined) args.push('-open', req.url)
    await exec('terminal-notifier', args)
    return
  } catch {
    // not installed or failed — try osascript
  }
  const script =
    `display notification "${applescriptQuote(req.body)}" ` +
    `with title "${applescriptQuote(req.title)}"`
  await exec('osascript', ['-e', script])
}

async function notifyLinux(req: NotificationRequest, exec: ExecFn): Promise<void> {
  // notify-send has no click action; the UI URL rides in the body.
  const body = req.url !== undefined ? `${req.body} — ${req.url}` : req.body
  await exec('notify-send', [req.title, body])
}

export interface NotifierOptions {
  /** Override process.platform (tests). */
  platform?: NodeJS.Platform
  /** Override the exec implementation (tests). */
  exec?: ExecFn
}

/**
 * Build the platform notifier. Unknown platforms get a no-op; exec failures
 * are swallowed so notification problems never surface as run failures.
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? defaultExec
  return {
    async notify(req) {
      try {
        if (platform === 'darwin') await notifyDarwin(req, exec)
        else if (platform === 'linux') await notifyLinux(req, exec)
      } catch {
        // degrade silently: no terminal-notifier, no osascript, headless env
      }
    },
  }
}

/** A notifier that records requests instead of shelling out (tests/demo). */
export function createRecordingNotifier(): Notifier & { requests: NotificationRequest[] } {
  const requests: NotificationRequest[] = []
  return {
    requests,
    async notify(req) {
      requests.push(req)
    },
  }
}

/**
 * The post-run notification payload: "N enriched, M need login" plus a link
 * back to the UI. `enriched` counts the enrich stage's ok rows; needs-login
 * is the needs_login collection size after the pass.
 */
export function runNotification(
  record: HarnessRunRecord,
  uiUrl?: string,
): NotificationRequest {
  if (record.error !== undefined) {
    return {
      title: 'linkinbox run failed',
      body: record.error,
      ...(uiUrl !== undefined ? { url: uiUrl } : {}),
    }
  }
  const enriched = record.summary.enrich.ok
  const needsLogin = record.summary.collections.collections['needs_login'] ?? 0
  const needsAction = record.summary.needsAction ? ' — action needed' : ''
  return {
    title: 'linkinbox run finished',
    body: `${enriched} enriched, ${needsLogin} need login${needsAction}`,
    ...(uiUrl !== undefined ? { url: uiUrl } : {}),
  }
}
