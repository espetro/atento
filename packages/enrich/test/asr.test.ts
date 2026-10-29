import { describe, expect, it } from 'vitest'
import {
  ASR_ENV_KEYS,
  asrArgs,
  asrConfigFromEnv,
  createAudiocppAsr,
  parseAudiocppOutput,
} from '../src/asr/index.js'

describe('asr config from env', () => {
  it('uses the documented defaults', () => {
    const config = asrConfigFromEnv({})
    expect(config.bin).toBe('audiocpp_cli')
    expect(config.family).toBe('parakeet_tdt')
    expect(config.backend).toBe('metal')
    expect(config.model).toBe('')
  })

  it('reads every knob from the environment', () => {
    const config = asrConfigFromEnv({
      [ASR_ENV_KEYS.bin]: '/opt/homebrew/bin/audiocpp_cli',
      [ASR_ENV_KEYS.family]: 'nemotron_asr',
      [ASR_ENV_KEYS.model]: '/models/nemotron.gguf',
      [ASR_ENV_KEYS.backend]: 'cpu',
    })
    expect(config).toEqual({
      bin: '/opt/homebrew/bin/audiocpp_cli',
      family: 'nemotron_asr',
      model: '/models/nemotron.gguf',
      backend: 'cpu',
    })
  })
})

describe('asr args', () => {
  it('builds the asr task invocation', () => {
    const args = asrArgs(
      { bin: 'x', family: 'parakeet_tdt', model: '/m.gguf', backend: 'metal' },
      '/tmp/a.wav',
    )
    expect(args).toEqual([
      '--task',
      'asr',
      '--family',
      'parakeet_tdt',
      '--model',
      '/m.gguf',
      '--backend',
      'metal',
      '--audio',
      '/tmp/a.wav',
      '--metrics',
    ])
  })
})

describe('parseAudiocppOutput', () => {
  it('splits the transcript from the metrics', () => {
    const out = parseAudiocppOutput(
      [
        'family=parakeet_tdt',
        'hello there',
        'general knowledge',
        'metrics.wall_ms=682.962',
        'metrics.rtf=0.115516',
      ].join('\n'),
    )
    expect(out.text).toBe('hello there\ngeneral knowledge')
    expect(out.metrics['metrics.rtf']).toBeCloseTo(0.115516)
    expect(out.metrics['metrics.wall_ms']).toBeCloseTo(682.962)
  })
})

describe('createAudiocppAsr', () => {
  it('returns the transcript and metrics', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const asr = createAudiocppAsr({
      env: { [ASR_ENV_KEYS.model]: '/models/m.gguf' },
      exec: async (file, args) => {
        calls.push({ file, args })
        return {
          code: 0,
          stdout: 'text_output=hello world\nmetrics.wall_ms=10\nmetrics.audio_duration_ms=4000\n',
          stderr: '',
        }
      },
    })
    const result = await asr({ audioPath: '/tmp/a.wav' })
    expect(calls[0]?.file).toBe('audiocpp_cli')
    expect(calls[0]?.args).toContain('--audio')
    expect(result.text).toBe('hello world')
    expect(result.audioDurationSeconds).toBeCloseTo(4)
  })

  it('fails when no model is configured', async () => {
    const asr = createAudiocppAsr({
      env: {},
      exec: async () => {
        throw new Error('must not run')
      },
    })
    await expect(asr({ audioPath: '/tmp/a.wav' })).rejects.toThrow(/ASR model not configured/)
  })

  it('fails when the provider exits non-zero', async () => {
    const asr = createAudiocppAsr({
      env: { [ASR_ENV_KEYS.model]: '/models/m.gguf' },
      exec: async () => ({ code: 3, stdout: '', stderr: 'model not found' }),
    })
    await expect(asr({ audioPath: '/tmp/a.wav' })).rejects.toThrow(/model not found/)
  })
})
