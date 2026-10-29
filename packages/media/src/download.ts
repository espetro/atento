/**
 * Audio download and conversion: yt-dlp pulls the audio out of the page,
 * ffmpeg converts it to 16 kHz mono wav for the ASR provider. Both binaries
 * are injectable so tests run offline against fakes.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_YTDLP_BIN = '/opt/homebrew/bin/yt-dlp'
export const DEFAULT_FFMPEG_BIN = 'ffmpeg'

export interface ExecLike {
  (
    file: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>
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

export interface DownloadOptions {
  ytdlpBin?: string
  ffmpegBin?: string
  exec?: ExecLike
  timeoutMs?: number
  /** Pass --cookies-from-browser to yt-dlp. Off by default. */
  cookiesFromBrowser?: boolean
  /** Pre-created working dir; a temp dir is created when omitted. */
  workDir?: string
}

export interface DownloadResult {
  /** Absolute path to the converted 16 kHz mono wav. */
  wavPath: string
  /** Cleaned up by the caller with cleanupMedia(). */
  workDir: string
  /** yt-dlp's JSON info, when it produced one. */
  info: Record<string, unknown> | null
}

export class DownloadError extends Error {}

/**
 * Download the audio for one URL and convert it to 16 kHz mono wav.
 * The caller must clean up the working directory when done.
 */
export async function downloadAudio(url: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const exec = options.exec ?? defaultExec
  const ytdlpBin = options.ytdlpBin ?? DEFAULT_YTDLP_BIN
  const ffmpegBin = options.ffmpegBin ?? DEFAULT_FFMPEG_BIN
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'linkinbox-media-')))
  const infoPath = join(workDir, 'info.json')
  const rawPath = join(workDir, 'audio.%(ext)s')

  const ytdlpArgs = [
    '-x',
    '--audio-format',
    'wav',
    '--write-info-json',
    '--no-playlist',
    '--no-warnings',
    '-o',
    rawPath,
    ...(options.cookiesFromBrowser ? ['--cookies-from-browser', 'safari'] : []),
    url,
  ]

  const dl = await exec(ytdlpBin, ytdlpArgs, { timeoutMs: options.timeoutMs ?? 600_000 })
  if (dl.code !== 0) {
    throw new DownloadError(
      `yt-dlp failed (exit ${dl.code}): ${(dl.stderr || dl.stdout).trim().slice(0, 400)}`,
    )
  }

  let info: Record<string, unknown> | null = null
  try {
    const raw = await readFile(infoPath, 'utf8')
    info = JSON.parse(raw) as Record<string, unknown>
  } catch {
    info = null
  }

  const wavPath = join(workDir, 'audio16k.wav')
  const conv = await exec(
    ffmpegBin,
    ['-y', '-i', join(workDir, 'audio.wav'), '-ar', '16000', '-ac', '1', wavPath],
    { timeoutMs: options.timeoutMs ?? 300_000 },
  )
  if (conv.code !== 0) {
    throw new DownloadError(
      `ffmpeg failed (exit ${conv.code}): ${(conv.stderr || conv.stdout).trim().slice(0, 400)}`,
    )
  }

  return { wavPath, workDir, info }
}

/** Delete the working directory (downloaded media); keep nothing. */
export async function cleanupMedia(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true })
}

/** Write a local wav into a fresh work dir (used by tests and the live check). */
export async function stageLocalAudio(
  wavBytes: Buffer,
  options: { workDir?: string } = {},
): Promise<{ wavPath: string; workDir: string }> {
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'linkinbox-media-')))
  const wavPath = join(workDir, 'audio16k.wav')
  await writeFile(wavPath, wavBytes)
  return { wavPath, workDir }
}

/** Read a wav file (helper for callers that stage audio directly). */
export async function readWav(path: string): Promise<Buffer> {
  return readFile(path)
}
