<script lang="ts">
  import { acpAgents, acpConfigure, acpStatus, type AcpAgent, type AcpStatus } from '../acp'
  import IconCheck from '~icons/lucide/check'
  import { m } from '../../paraglide/messages.js'

  /**
   * Status dot to the right of the Agent button. Nothing is installed or
   * started at launch: the shell only probes PATH for known ACP agents, and
   * this menu shows what it found and lets the user pick one (or a custom
   * command). The agent process itself starts on the first prompt.
   */
  let status = $state<AcpStatus | null>(null)
  let agents = $state<AcpAgent[]>([])
  let configured = $state<string[] | null>(null)
  let open = $state(false)
  let custom = $state('')
  let error = $state('')

  async function refresh() {
    const [s, a] = await Promise.all([acpStatus(), acpAgents()])
    status = s
    agents = a?.available ?? []
    configured = a?.configured ?? null
  }

  $effect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(id)
  })
  $effect(() => {
    if (open) void refresh()
  })

  const tone = $derived(
    status?.error ? 'bad' : status?.connected ? 'ok' : configured ? 'ready' : 'none',
  )
  const label = $derived(
    tone === 'bad'
      ? m.agent_status_error()
      : tone === 'ok'
        ? m.agent_status_connected()
        : tone === 'ready'
          ? m.agent_status_ready()
          : m.agent_status_none(),
  )
  const same = (a: string[] | null, b: string[]) => a != null && a.join(' ') === b.join(' ')

  async function choose(command: string[]) {
    error = ''
    try {
      await acpConfigure(command)
      await refresh()
      open = false
    } catch (e) {
      error = String(e)
    }
  }

  function saveCustom() {
    const cmd = custom.trim().split(/\s+/).filter(Boolean)
    if (cmd.length > 0) void choose(cmd)
  }

  function dismiss(e: Event) {
    if (!open) return
    if (e instanceof KeyboardEvent) {
      if (e.key === 'Escape') open = false
      return
    }
    if (!(e.target as Element | null)?.closest('.agent-status')) open = false
  }
</script>

<svelte:window onpointerdown={dismiss} onkeydown={dismiss} />

<span class="agent-status">
  <button
    type="button"
    class="status-btn"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`${m.assistant_title()}: ${label}`}
    title={label}
    onclick={() => (open = !open)}
    data-testid="agent-status"
  >
    <span class="dot dot-{tone}"></span>
  </button>
  {#if open}
    <div class="menu" role="menu" data-testid="agent-status-menu">
      <p class="menu-head"><span class="dot dot-{tone}"></span> {label}</p>
      {#if configured}
        <p class="menu-cmd">{configured.join(' ')}</p>
      {/if}
      {#if status?.error}<p class="menu-err">{status.error}</p>{/if}
      <p class="menu-sub">{m.agent_menu_detected()}</p>
      {#each agents as a (a.id)}
        <button type="button" class="menu-item" role="menuitemradio" aria-checked={same(configured, a.command)} onclick={() => choose(a.command)}>
          <span class="check">{#if same(configured, a.command)}<IconCheck />{/if}</span>
          <span class="item-label">{a.label}</span>
          <span class="item-path">{a.command.join(' ')}</span>
        </button>
      {:else}
        <p class="menu-none">{m.agent_menu_none()}</p>
      {/each}
      <p class="menu-sub">{m.agent_menu_custom()}</p>
      <form class="menu-custom" onsubmit={(e) => { e.preventDefault(); saveCustom() }}>
        <input class="input" bind:value={custom} placeholder={m.assistant_agent_placeholder()} data-testid="assistant-agent-input" />
        <button type="submit" class="btn btn-sm btn-primary" disabled={custom.trim() === ''}>{m.assistant_save_agent()}</button>
      </form>
      {#if error}<p class="menu-err">{error}</p>{/if}
    </div>
  {/if}
</span>

<style>
  .agent-status {
    position: relative;
    display: inline-flex;
  }
  .status-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
  }
  .status-btn:hover,
  .status-btn[aria-expanded='true'] {
    background: var(--color-sidebar-accent);
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .dot-ok { background: var(--color-state-done, #2f9e62); }
  .dot-ready { background: var(--color-accent-blue); }
  .dot-none { background: var(--color-ink-faint); }
  .dot-bad { background: var(--color-state-blocked, #d9534f); }
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    width: 300px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 12px;
    box-shadow: var(--shadow-pop);
    z-index: 60;
    font-size: 12.5px;
  }
  .menu-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-weight: 600;
    font-size: 13px;
  }
  .menu-cmd,
  .item-path {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    color: var(--color-ink-soft);
  }
  .menu-cmd { margin: 0; }
  .menu-sub {
    margin: 6px 0 0;
    font-size: 11px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
  }
  .menu-none,
  .menu-err {
    margin: 0;
    color: var(--color-ink-soft);
  }
  .menu-err { color: var(--color-state-blocked, #d9534f); }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--color-ink);
    text-align: left;
    cursor: pointer;
  }
  .menu-item:hover { background: var(--color-accent-wash); }
  .check { width: 14px; flex: none; color: var(--color-accent-blue); display: inline-flex; }
  .item-label { font-weight: 500; }
  .item-path { margin-left: auto; }
  .menu-custom {
    display: flex;
    gap: 6px;
  }
</style>
