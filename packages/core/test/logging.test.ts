import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeLogging, pipelineLogger, resolveLogPath, setupLogging, toPipelineLogger } from '../src/index.js'
import { createCollectingLogger } from '../src/index.js'

afterEach(() => {
  disposeLogging()
})

describe('logging', () => {
  it('writes one JSON line per log call to the file sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-log-'))
    const path = join(dir, 'log.jsonl')
    const setup = setupLogging({ path, console: false })
    const log = pipelineLogger('ingest')
    log.info('ingested {url}', { url: 'https://example.com/a' })
    log.warn('needs browser {url}', { url: 'https://x.com/b' })
    setup.dispose()

    const raw = readFileSync(path, 'utf8').trim()
    const lines = raw.split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!) as { level: string; message: string; logger: string; properties: Record<string, unknown> }
    expect(first.level).toBe('INFO')
    expect(first.message).toContain('https://example.com/a')
    expect(first.logger).toBe('atento.ingest')
    expect(first.properties['url']).toBe('https://example.com/a')
    const second = JSON.parse(lines[1]!) as { level: string }
    expect(second.level).toBe('WARN')
  })

  it('creates the log directory when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-log-'))
    const path = join(dir, 'nested', 'deeper', 'log.jsonl')
    const setup = setupLogging({ path, console: false })
    pipelineLogger('test').info('hello')
    setup.dispose()
    expect(existsSync(path)).toBe(true)
  })

  it('resolves the path from env before the default', () => {
    expect(resolveLogPath({ ATENTO_LOG_FILE: '/tmp/x.jsonl' })).toBe('/tmp/x.jsonl')
    expect(resolveLogPath({})).toContain(join('.atento', 'log.jsonl'))
  })

  it('toPipelineLogger adapts LogTape to the PipelineLogger shape', () => {
    const collecting = createCollectingLogger()
    const adapted = toPipelineLogger(collecting)
    adapted.info('hello {n}', { n: 1 })
    expect(collecting.records).toHaveLength(1)
    expect(collecting.records[0]!.properties).toEqual({ n: 1 })
  })
})
