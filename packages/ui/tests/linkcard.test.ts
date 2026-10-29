import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import LinkCard from '../src/views/LinkCard.svelte'
import type { LinkSummary } from '../src/lib/types'

const link: LinkSummary = {
  id: 7,
  title: 'A practical guide to agent memory',
  url: 'https://example.com/agent-memory',
  category: 'ai',
  priority: 'high',
  why_it_matters: 'Reframes the approach we took last quarter.',
  read_minutes: 12,
  status: 'inbox',
  expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  expiry_reason: 'Version-specific API behaviour.',
  action: 'read_now',
}

describe('LinkCard', () => {
  it('renders title, category, priority dot, why, read minutes, stale badge', () => {
    render(LinkCard, { props: { link, onAction: vi.fn(), onOpen: vi.fn() } })
    expect(screen.getByTestId('link-title').textContent).toContain('agent memory')
    expect(screen.getByTestId('link-category').textContent).toBe('ai')
    expect(screen.getByTestId('priority-dot')).toBeTruthy()
    expect(screen.getByText('Reframes the approach we took last quarter.')).toBeTruthy()
    expect(screen.getByText('12 min')).toBeTruthy()
    expect(screen.getByTestId('stale-badge')).toBeTruthy()
  })

  it('emits onAction with the pressed triage action', async () => {
    const onAction = vi.fn()
    render(LinkCard, { props: { link, onAction, onOpen: vi.fn() } })
    await fireEvent.click(screen.getByTestId('action-archive'))
    expect(onAction).toHaveBeenCalledWith(7, 'archive')
  })

  it('emits onOpen on title click', async () => {
    const onOpen = vi.fn()
    render(LinkCard, { props: { link, onAction: vi.fn(), onOpen } })
    await fireEvent.click(screen.getByTestId('link-title'))
    expect(onOpen).toHaveBeenCalledWith(7)
  })
})
