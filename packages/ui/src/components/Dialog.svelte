<script lang="ts">
  import type { Snippet } from 'svelte'
  import { dialogClosed, dialogOpened } from '../lib/keyboard'

  /**
   * Modal dialog: overlay click + Esc close, focus moves into the card on
   * open and is trapped while open (Tab cycles the focusable elements).
   */
  let {
    open = false,
    labelledBy,
    onClose,
    children,
  }: {
    open?: boolean
    labelledBy?: string
    onClose: () => void
    children: Snippet
  } = $props()

  let cardEl = $state<HTMLElement | null>(null)
  let previousFocus: HTMLElement | null = null

  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

  $effect(() => {
    if (!open) return
    dialogOpened()
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Move focus into the dialog on the next tick (children must be mounted).
    const id = requestAnimationFrame(() => {
      const first = cardEl?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? cardEl)?.focus()
    })
    // Escape works even when focus somehow lands outside the card.
    const onWinKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onWinKey, true)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('keydown', onWinKey, true)
      dialogClosed()
      previousFocus?.focus?.()
    }
  })

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !cardEl) return
    const items = [...cardEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === cardEl)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="dialog-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}
    onkeydown={onKeydown}
  >
    <div
      class="dialog-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabindex="-1"
      bind:this={cardEl}
      onkeydown={onKeydown}
    >
      {@render children()}
    </div>
  </div>
{/if}
