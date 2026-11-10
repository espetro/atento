/**
 * The ASR provider interface and the audiocpp (audio.cpp) adapter.
 *
 * Everything is env-driven: the binary, the model family, the model path and
 * the backend come from the environment, never from a hardcoded value.
 */
import type { AsrFn, AsrRequest, AsrResponse } from '@atento/core'

export type { AsrFn, AsrRequest, AsrResponse }

/** How to run one subprocess. Injected in tests so nothing hits the network. */
export interface ExecLike {
  (
    file: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>
}

/** Env keys the adapter reads. */
export const ASR_ENV_KEYS = {
  bin: 'ATENTO_ASR_BIN',
  family: 'ATENTO_ASR_FAMILY',
  model: 'ATENTO_ASR_MODEL',
  backend: 'ATENTO_ASR_BACKEND',
} as const

/** Documented defaults. The model path has no default: it must be set. */
export const DEFAULT_ASR_BIN = 'audiocpp_cli'
export const DEFAULT_ASR_FAMILY = 'parakeet_tdt'
export const DEFAULT_ASR_BACKEND = 'metal'

export interface AsrConfig {
  /** The CLI binary. */
  bin: string
  /** Model family passed to the CLI. */
  family: string
  /** Model file or package directory. */
  model: string
  /** Compute backend. */
  backend: string
}

export interface AudioCppOptions {
  /** Override the subprocess runner (tests). */
  exec?: ExecLike
  /** Environment holding the model config. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Override the whole config (tests). */
  config?: Partial<AsrConfig>
  /** Subprocess timeout in ms. */
  timeoutMs?: number
}

/** Resolve the ASR config from the environment. */
export function asrConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AsrConfig> = {},
): AsrConfig {
  const bin = env[ASR_ENV_KEYS.bin]?.trim()
  const family = env[ASR_ENV_KEYS.family]?.trim()
  const model = env[ASR_ENV_KEYS.model]?.trim()
  const backend = env[ASR_ENV_KEYS.backend]?.trim()
  return {
    bin: overrides.bin ?? (bin && bin !== '' ? bin : DEFAULT_ASR_BIN),
    family: overrides.family ?? (family && family !== '' ? family : DEFAULT_ASR_FAMILY),
    model: overrides.model ?? (model && model !== '' ? model : ''),
    backend: overrides.backend ?? (backend && backend !== '' ? backend : DEFAULT_ASR_BACKEND),
  }
}

/** Build the audiocpp_cli argument list for one request. */
export function asrArgs(config: AsrConfig, audioPath: string): string[] {
  const args = [
    '--task',
    'asr',
    '--family',
    config.family,
    '--model',
    config.model,
    '--backend',
    config.backend,
    '--audio',
    audioPath,
    '--metrics',
  ]
  return args
}

function defaultExec(
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile: run }) => {
      run(
        file,
        args,
        { timeout: options?.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? 1 : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          })
        },
      )
    })
  })
}

/**
 * Parse the key=value output the CLI prints after the transcript.
 *
 * The transcript arrives as one `text_output=...` line; everything else is
 * `key=value` (metrics, family, word timestamps) and is either kept as a
 * numeric metric or dropped.
 */
export function parseAudiocppOutput(stdout: string): {
  text: string
  metrics: Record<string, number>
} {
  const metrics: Record<string, number> = {}
  const textLines: string[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/.exec(line)
    if (match) {
      if (match[1] === 'text_output') textLines.push(match[2] ?? '')
      const value = Number(match[2])
      if (Number.isFinite(value) && match[2] !== '') metrics[match[1]!] = value
      continue
    }
    textLines.push(line)
  }
  const text = textLines.join('\n').trim()
  return { text, metrics }
}

/**
 * Build an AsrFn backed by audiocpp_cli (audio.cpp), running fully local.
 *
 * The model identity comes from the environment: `ATENTO_ASR_BIN`,
 * `ATENTO_ASR_FAMILY`, `ATENTO_ASR_MODEL` and `ATENTO_ASR_BACKEND`.
 */
export function createAudiocppAsr(options: AudioCppOptions = {}): AsrFn {
  const exec = options.exec ?? defaultExec
  const env = options.env ?? process.env
  const config = asrConfigFromEnv(env, options.config ?? {})

  return async (request: AsrRequest): Promise<AsrResponse> => {
    if (config.model === '') {
      throw new Error(
        `ASR model not configured: set ${ASR_ENV_KEYS.model} to a model file or package directory`,
      )
    }
    const result = await exec(config.bin, asrArgs(config, request.audioPath), {
      timeoutMs: options.timeoutMs ?? 300_000,
    })
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`asr provider failed (exit ${result.code}): ${detail.slice(0, 500)}`)
    }
    const parsed = parseAudiocppOutput(result.stdout)
    const duration = parsed.metrics['metrics.audio_duration_ms']
    return {
      text: parsed.text,
      audioDurationSeconds: duration === undefined ? undefined : duration / 1000,
      metrics: parsed.metrics,
    }
  }
}
