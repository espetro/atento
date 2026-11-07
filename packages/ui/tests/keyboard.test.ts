// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { onShortcut, startKeyboard, dialogOpened, dialogClosed } from '../src/lib/keyboard'

function press(key: string, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('keyboard dispatcher', () => {
  beforeEach(() => {
    startKeyboard()
  })

  it('fires registered handlers for single keys', () => {
    const fn = vi.fn()
    const off = onShortcut('j', fn)
    press('j')
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    press('j')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ignores keys while a dialog is open', () => {
    const fn = vi.fn()
    const off = onShortcut('a', fn)
    dialogOpened()
    press('a')
    expect(fn).not.toHaveBeenCalled()
    dialogClosed()
    press('a')
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })

  it('ignores keys inside inputs', () => {
    const fn = vi.fn()
    const off = onShortcut('d', fn)
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('d', input)
    expect(fn).not.toHaveBeenCalled()
    input.remove()
    off()
  })

  it('ignores modified keys', () => {
    const fn = vi.fn()
    const off = onShortcut('k', fn)
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    document.body.dispatchEvent(e)
    expect(fn).not.toHaveBeenCalled()
    off()
  })
})
