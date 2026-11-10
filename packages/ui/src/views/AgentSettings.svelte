<script lang="ts">
  import { acpAgents, acpAvailable, acpConfigure, acpTest, type AcpAgent, type AcpAgents } from '../lib/acp'
  import { m } from '../paraglide/messages.js'
  import IconChevron from '~icons/lucide/chevron-right'
  import IconRefresh from '~icons/lucide/refresh-cw'
  import IconTrash from '~icons/lucide/trash-2'

  /**
   * ACP agents as a list of cards (layout after t3code's provider settings):
   * each card shows availability, an enable switch and a status line; the
   * expanded card has the command, a real connection test and the models the
   * agent advertises. Nothing here starts an agent except the explicit Test.
   */
  let available = $state<boolean | null>(null)
  let data = $state<AcpAgents | null>(null)
  let openId = $state<string | null>(null)
  let busy = $state<Record<string, boolean>>({})
  let error = $state('')
  let customLabel = $state('')
  let customCmd = $state('')

  async function load() {
    data = await acpAgents()
  }
  $effect(() => {
    void acpAvailable().then(async (ok) => {
      available = ok
      if (ok) {
        await load()
        openId = data?.agents.find((a) => a.active)?.id ?? null
      }
    })
  })

  async function run(id: string, fn: () => Promise<unknown>) {
    busy[id] = true
    error = ''
    try {
      await fn()
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy[id] = false
    }
  }

  const setEnabled = (a: AcpAgent, enabled: boolean) => run(a.id, () => acpConfigure({ id: a.id, enabled }))
  const makeActive = (a: AcpAgent) => run(a.id, () => acpConfigure(a.command))
  const setModel = (a: AcpAgent, model: string) => run(a.id, () => acpConfigure({ id: a.id, model }))
  const test = (a: AcpAgent) => run(a.id, () => acpTest(a.id))
  const removeCustom = (a: AcpAgent) => run(a.id, () => acpConfigure({ removeCustom: a.id }))

  function addCustom() {
    const command = customCmd.trim().split(/\s+/).filter(Boolean)
    if (command.length === 0) return
    const label = customLabel.trim() || command.join(' ')
    void run('custom', () => acpConfigure({ custom: { label, command } })).then(() => {
      customLabel = ''
      customCmd = ''
    })
  }

  function headline(a: AcpAgent): { tone: 'ok' | 'warn' | 'bad' | 'off'; text: string } {
    if (a.path === null) return { tone: 'off', text: m.agent_not_installed() }
    if (!a.enabled) return { tone: 'off', text: m.agent_disabled() }
    if (a.probe && !a.probe.ok) return { tone: 'bad', text: m.agent_test_failed() }
    if (a.probe?.ok) return { tone: 'ok', text: m.agent_test_ok({ ms: a.probe.ms }) }
    return { tone: 'warn', text: m.agent_untested() }
  }
  const dash = (v: string | undefined | null) => (v && v !== '' ? v : '—')
</script>

<div class="agents" data-testid="settings-agent">
  <p class="note">{m.agent_settings_note()}</p>

  {#if available === false}
    <div class="group"><div class="row"><span class="desc">{m.assistant_not_configured()}</span></div></div>
  {:else if data === null}
    <div class="skeleton" style="height: 96px; border-radius: 12px;"></div>
  {:else}
    <div class="list">
      {#each data.agents as a (a.id)}
        {@const st = headline(a)}
        {@const isOpen = openId === a.id}
        <section class="group card-agent" class:dim={!a.enabled || a.path === null} data-testid={`agent-card-${a.id}`}>
          <div class="head">
            <button
              type="button"
              class="head-btn"
              aria-expanded={isOpen}
              onclick={() => (openId = isOpen ? null : a.id)}
            >
              <span class="chev" class:open={isOpen}><IconChevron /></span>
              <span class="head-text">
                <span class="name-row">
                  <span class="name">{a.label}</span>
                  {#if a.probe?.agent?.version}<code class="ver">{a.probe.agent.version}</code>{/if}
                  {#if a.active && a.path !== null && a.enabled}<span class="badge-active">{m.agent_active()}</span>{/if}
                </span>
                <span class="agent-status-line"><span class="agent-dot dot-{st.tone}"></span><span class="agent-status-text">{st.text}</span></span>
              </span>
            </button>
            <button
              type="button"
              class="switch"
              role="switch"
              aria-checked={a.enabled}
              aria-label={m.agent_enable({ name: a.label })}
              disabled={busy[a.id] === true || a.path === null}
              onclick={() => void setEnabled(a, !a.enabled)}
              data-testid={`agent-enable-${a.id}`}
            ><span class="knob"></span></button>
          </div>

          {#if isOpen}
            <div class="body">
              <div class="sec-title">{m.agent_section_connection()}</div>
              <div class="row">
                <div class="row-text">
                  <div class="row-title">{m.agent_command()}</div>
                  <code class="desc mono">{a.command.join(' ')}</code>
                </div>
              </div>
              <div class="row">
                <div class="row-text">
                  <div class="row-title">{m.agent_binary()}</div>
                  <code class="desc mono">{a.path ?? m.agent_not_found()}</code>
                </div>
              </div>
              <div class="row">
                <div class="row-text">
                  <div class="row-title">{m.agent_test()}</div>
                  <div class="desc">
                    {#if a.probe === null}
                      {m.agent_test_hint()}
                    {:else if a.probe.ok}
                      {dash(a.probe.agent?.name)} {a.probe.agent?.version ?? ''} · ACP v{a.probe.protocolVersion ?? '?'} · {m.agent_test_ok({ ms: a.probe.ms })}
                      {#if a.probe.authMethods?.length}<br />{m.agent_auth_methods()}: {a.probe.authMethods.map((x) => x.name ?? x.id).join(', ')}{/if}
                    {:else}
                      <span class="err">{a.probe.error}</span>
                    {/if}
                  </div>
                </div>
                <div class="row-ctl">
                  <button type="button" class="btn btn-sm" disabled={busy[a.id] === true || a.path === null} onclick={() => void test(a)} data-testid={`agent-test-${a.id}`}>
                    <span class:spin={busy[a.id] === true}><IconRefresh /></span>
                    {busy[a.id] === true ? m.agent_testing() : m.agent_test_run()}
                  </button>
                </div>
              </div>

              <div class="sec-title">{m.agent_section_models()}</div>
              {#if a.probe?.ok && a.probe.models && a.probe.models.available.length > 0}
                {#each a.probe.models.available as model (model.modelId)}
                  {@const chosen = (a.model ?? a.probe.models.current) === model.modelId}
                  <button
                    type="button"
                    class="row model"
                    role="radio"
                    aria-checked={chosen}
                    disabled={busy[a.id] === true}
                    onclick={() => void setModel(a, model.modelId)}
                  >
                    <span class="radio" class:on={chosen}></span>
                    <span class="row-text">
                      <span class="row-title">{model.name ?? model.modelId}</span>
                      <code class="desc mono">{model.modelId}</code>
                    </span>
                    {#if a.probe.models.current === model.modelId}<span class="tag">{m.agent_model_default()}</span>{/if}
                  </button>
                {/each}
                {#if a.model}
                  <div class="row">
                    <span class="desc">{m.agent_model_pref({ model: a.model })}</span>
                    <button type="button" class="btn btn-sm btn-ghost" onclick={() => void setModel(a, '')}>{m.agent_model_clear()}</button>
                  </div>
                {/if}
              {:else}
                <div class="row"><span class="desc">{a.probe?.ok ? m.agent_models_none() : m.agent_models_untested()}</span></div>
              {/if}

              <div class="foot">
                {#if a.custom}
                  <button type="button" class="btn btn-sm btn-ghost danger" onclick={() => void removeCustom(a)}><IconTrash /> {m.agent_remove()}</button>
                {/if}
                <span class="grow"></span>
                {#if a.active}
                  <span class="desc">{m.agent_is_active()}</span>
                {:else}
                  <button type="button" class="btn btn-sm btn-primary" disabled={busy[a.id] === true || a.path === null || !a.enabled} onclick={() => void makeActive(a)} data-testid={`agent-use-${a.id}`}>{m.agent_use()}</button>
                {/if}
              </div>
            </div>
          {/if}
        </section>
      {/each}
    </div>

    <section class="group">
      <div class="sec-title pad">{m.agent_add_title()}</div>
      <form class="add" onsubmit={(e) => { e.preventDefault(); addCustom() }}>
        <input class="input" placeholder={m.agent_add_name()} bind:value={customLabel} />
        <input class="input mono" placeholder={m.agent_add_command()} bind:value={customCmd} data-testid="agent-custom-input" />
        <button type="submit" class="btn btn-sm btn-primary" disabled={customCmd.trim() === '' || busy['custom'] === true} data-testid="agent-custom-save">{m.agent_add()}</button>
      </form>
    </section>
    {#if error}<p class="err pad-x">{error}</p>{/if}
  {/if}
</div>

<style>
  .agents {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .note {
    font-size: 12.5px;
    color: var(--color-ink-faint);
    padding: 0 2px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .group {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .group.dim .head {
    opacity: 0.65;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 0 6px;
  }
  .head-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 13px 10px;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    border-radius: 10px;
  }
  .head-btn:focus-visible {
    outline: 2px solid var(--color-accent-blue);
    outline-offset: -2px;
  }
  .chev {
    display: inline-flex;
    color: var(--color-ink-faint);
    transition: transform 160ms var(--ease-out-expo);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .agent-status-text {
    white-space: nowrap;
  }
  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--color-ink);
  }
  .ver {
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .badge-active {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    color: var(--color-accent-blue);
    background: color-mix(in srgb, var(--color-accent-blue) 12%, transparent);
  }
  .agent-status-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--color-ink-faint);
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--color-ink-faint);
  }
  .dot-ok {
    background: var(--color-state-enriched);
  }
  .dot-warn {
    background: var(--color-state-needs-login);
  }
  .dot-bad {
    background: var(--color-state-blocked);
  }
  .dot-off {
    background: var(--color-line-strong);
  }
  .switch {
    flex: none;
    width: 32px;
    height: 18px;
    border-radius: 999px;
    border: none;
    padding: 2px;
    background: var(--color-line-strong);
    cursor: pointer;
    transition: background-color 140ms var(--ease-out-expo);
  }
  .switch[aria-checked='true'] {
    background: var(--color-accent-blue);
  }
  .switch:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .switch:focus-visible {
    outline: 2px solid var(--color-accent-blue);
    outline-offset: 2px;
  }
  .knob {
    display: block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
    transition: transform 140ms var(--ease-out-expo);
  }
  .switch[aria-checked='true'] .knob {
    transform: translateX(14px);
  }
  .body {
    border-top: 1px solid var(--color-line);
  }
  .sec-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
    padding: 14px 18px 6px;
  }
  .sec-title.pad {
    padding-top: 16px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 11px 18px;
    width: 100%;
    text-align: left;
  }
  .row + .row {
    border-top: 1px solid var(--color-line);
  }
  .row-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .row-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-ink);
  }
  .desc {
    font-size: 12px;
    color: var(--color-ink-faint);
    overflow-wrap: anywhere;
  }
  .row-ctl {
    flex: none;
    display: flex;
    gap: 8px;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .err {
    color: var(--color-state-blocked);
    font-size: 12.5px;
  }
  .pad-x {
    padding: 0 4px;
  }
  button.model {
    background: none;
    border-inline: none;
    border-bottom: none;
    cursor: pointer;
  }
  button.model:hover:not(:disabled) {
    background: var(--color-accent-wash);
  }
  .radio {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--color-line-strong);
  }
  .radio.on {
    border-color: var(--color-accent-blue);
    background: radial-gradient(circle, var(--color-accent-blue) 0 38%, transparent 42%);
  }
  .tag {
    flex: none;
    font-size: 10.5px;
    color: var(--color-ink-faint);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--color-line);
    margin-top: 6px;
  }
  .grow {
    flex: 1;
  }
  .danger {
    color: var(--color-state-blocked);
  }
  .add {
    display: grid;
    grid-template-columns: 1fr 1.6fr auto;
    gap: 10px;
    padding: 6px 18px 18px;
    align-items: center;
  }
  .spin {
    display: inline-flex;
    animation: agent-spin 800ms linear infinite;
  }
  @keyframes agent-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 759px) {
    .add {
      grid-template-columns: 1fr;
    }
  }
</style>
