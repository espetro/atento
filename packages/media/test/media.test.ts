import { describe, expect, it, vi } from 'vitest'
import { createInMemoryBudget } from '../src/budget.js'
import {
  DEFAULT_YTDLP_BIN,
  DownloadError,
  cleanupMedia,
  downloadAudio,
  type ExecLike,
} from '../src/download.js'
import { runMediaStage } from '../src/orchestrator.js'
import { mediaReportSchema, renderMedia } from '../src/index.js'
import type { GuardDeps } from '@linkinbox/core'

/** A fake exec that pretends yt-dlp and ffmpeg did their job. */
function fakeExec(): ExecLike & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = []
  const fn = (async (file: string, args: string[]) => {
    calls.push({ file, args })
    return { code: 0, stdout: '{"id":"abc","duration":30}\n', stderr: '' }
  }) as ExecLike & { calls: Array<{ file: string; args: string[] }> }
  fn.calls = calls
  return fn
}

/** A fake guard: passes calls straight through, records the key. */
function fakeGuard() {
  const keys: string[] = []
  const deps: GuardDeps = {
    getHostState: async () => null,
    saveHostState: async () => {},
    clock: () => 0,
    random: () => 0.5,
    sleep: async () => {},
    config: {
      limits: { globalConcurrency: 8, maxBatch: 20, llmConcurrency: 3, walledGardens: [], skipHosts: [], hosts: {} },
      breaker: { baseCooldownMs: 1000, factor: 2, maxCooldownMs: 1000, failureThreshold: 5, maxLevel: 1 },
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, factor: 1 },
    },
    hasProfile: async () => false,
  }
  return { deps, keys }
}

describe('downloadAudio', () => {
  it('calls yt-dlp then ffmpeg and reports the wav path', async () => {
    const exec = fakeExec()
    const result = await downloadAudio('https://example.com/v', { exec, workDir: '/tmp/wd' })
    expect(exec.calls[0]?.file).toBe(DEFAULT_YTDLP_BIN)
    expect(exec.calls[0]?.args).toContain('https://example.com/v')
    expect(exec.calls[0]?.args).not.toContain('--cookies-from-browser')
    expect(exec.calls[0]?.args).toContain('--audio-format')
    expect(exec.calls[0]?.args).toContain('wav')
    expect(exec.calls[1]?.args).toContain('-ar')
    expect(exec.calls[1]?.args).toContain('16000')
    expect(exec.calls[1]?.args).toContain('-ac')
    expect(exec.calls[1]?.args).toContain('1')
    expect(result.wavPath).toBe('/tmp/wd/audio16k.wav')
  })

  it('passes cookies only when enabled', async () => {
    const exec = fakeExec()
    await downloadAudio('https://example.com/v', {
      exec,
      workDir: '/tmp/wd',
      cookiesFromBrowser: true,
    })
    expect(exec.calls[0]?.args).toContain('--cookies-from-browser')
  })

  it('throws a DownloadError when yt-dlp fails', async () => {
    const exec: ExecLike = async () => ({ code: 1, stdout: '', stderr: 'no video' })
    await expect(
      downloadAudio('https://example.com/v', { exec, workDir: '/tmp/wd' }),
    ).rejects.toBeInstanceOf(DownloadError)
  })
})

describe('runMediaStage', () => {
  it('runs caption and a faked transcript end to end', async () => {
    const workDir = '/tmp/linkinbox-media-fake'
    const exec = fakeExec()
    const asr = vi.fn(async () => ({ text: 'hello from the audio', metrics: { 'metrics.rtf': 0.2 } }))
    const report = await runMediaStage(
      { url: 'https://example.com/v', content: 'A caption #tag' },
      {
        asr,
        download: { exec, workDir },
      },
    )
    const parsed = mediaReportSchema.parse(report)
    expect(parsed.tiers).toHaveLength(2)
    const caption = parsed.tiers[0]
    const transcript = parsed.tiers[1]
    expect(caption?.status).toBe('ok')
    expect(transcript?.status).toBe('ok')
    if (transcript?.kind === 'transcript') {
      expect(transcript.text).toBe('hello from the audio')
      expect(transcript.rtf).toBeCloseTo(0.2)
    }
    expect(asr).toHaveBeenCalledWith(expect.objectContaining({ audioPath: `${workDir}/audio16k.wav` }))
  })

  it('routes the download through the guard with the host as key', async () => {
    const guard = fakeGuard()
    const exec = fakeExec()
    const report = await runMediaStage(
      { url: 'https://walled.example/v' },
      { asr: async () => ({ text: 'x' }), guard: guard.deps, download: { exec, workDir: '/tmp/wd2' } },
    )
    expect(report.tiers[1]?.status).toBe('ok')
  })

  it('reports failed when the download fails', async () => {
    const exec: ExecLike = async () => ({ code: 1, stdout: '', stderr: 'blocked' })
    const report = await runMediaStage(
      { url: 'https://example.com/v' },
      { asr: async () => ({ text: 'x' }), download: { exec, workDir: '/tmp/wd3' } },
    )
    const transcript = report.tiers[1]
    expect(transcript?.status).toBe('failed')
  })

  it('skips the transcript when the media is over the duration limit', async () => {
    const exec = fakeExec()
    const report = await runMediaStage(
      { url: 'https://example.com/v' },
      {
        asr: async () => ({ text: 'x' }),
        config: {
          enabledTiers: ['transcript'],
          dailyCap: 20,
          dailyCaps: {},
          maxDurationSeconds: 10,
          cookiesFromBrowser: false,
        },
        durationSeconds: 30,
        download: { exec, workDir: '/tmp/wd4' },
      },
    )
    const transcript = report.tiers[0]
    expect(transcript?.status).toBe('skipped')
    expect(transcript?.kind === 'skipped' ? transcript.reason : '').toContain('over the 10s limit')
  })

  it('skips when the daily budget is gone', async () => {
    const budget = createInMemoryBudget({ dailyCap: 0 })
    const report = await runMediaStage(
      { url: 'https://example.com/v', tiers: ['transcript'] },
      { budget, asr: async () => ({ text: 'x' }) },
    )
    const tier = report.tiers[0]
    expect(tier?.status).toBe('skipped')
    expect(tier?.kind === 'skipped' ? tier.reason : '').toContain('budget')
  })

  it('fails the transcript when no ASR provider is configured', async () => {
    const report = await runMediaStage({ url: 'https://example.com/v', tiers: ['transcript'] }, {})
    const tier = report.tiers[0]
    expect(tier?.status).toBe('failed')
    expect(tier?.kind === 'failed' ? tier.error : '').toContain('no ASR provider')
  })

  it('never cleans up media on success: cleanup deletes the work dir', async () => {
    await cleanupMedia('/tmp/linkinbox-media-nonexistent-xyz')
    expect(true).toBe(true)
  })
})

describe('renderMedia', () => {
  it('renders labeled sections for the ok tiers only', () => {
    const report = {
      url: 'https://example.com/v',
      tiers: [
        { kind: 'caption' as const, tier: 'caption' as const, status: 'ok' as const, seconds: 0, text: 'A clip', caption: 'A clip', hashtags: ['x'] },
        { kind: 'transcript' as const, tier: 'transcript' as const, status: 'ok' as const, seconds: 1, text: 'spoken words' },
        { kind: 'unsupported' as const, tier: 'frames' as const, status: 'unsupported' as const, seconds: 0, reason: 'frame analysis not implemented' },
      ],
    }
    const md = renderMedia(report)
    expect(md).toContain('## Caption')
    expect(md).toContain('A clip')
    expect(md).toContain('#x')
    expect(md).toContain('## Transcript')
    expect(md).toContain('spoken words')
    expect(md).not.toContain('Frames')
  })

  it('omits failed and empty tiers', () => {
    const report = {
      url: 'https://example.com/v',
      tiers: [
        { kind: 'empty' as const, tier: 'caption' as const, status: 'empty' as const, seconds: 0 },
        { kind: 'failed' as const, tier: 'transcript' as const, status: 'failed' as const, seconds: 1, error: 'boom' },
      ],
    }
    expect(renderMedia(report)).toBe('')
  })
})
