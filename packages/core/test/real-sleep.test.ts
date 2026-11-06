import { describe, expect, it, vi } from 'vitest'
import { realSleep } from '../src/resilience/retry.js'

describe('realSleep', () => {
  it('keeps its timer referenced so a pending wait holds the process open', async () => {
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return { unref } as unknown as NodeJS.Timeout
    }) as typeof setTimeout)
    await realSleep(10)
    spy.mockRestore()
    expect(unref).not.toHaveBeenCalled()
  })
})
