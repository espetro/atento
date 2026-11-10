<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import { timeAgo } from '../lib/format'
  import CopyButton from '../lib/components/CopyButton.svelte'
  import { acpAvailable } from '../lib/acp'
  import { m } from '../paraglide/messages.js'
  import type { UrlState } from '../lib/urlState'

  let { url, setUrl }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()

  const browsersQuery = createQuery(() => ({
    queryKey: ['browsers'],
    queryFn: () => api.browsers(),
    staleTime: 15_000,
  }))
  const configQuery = createQuery(() => ({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 60_000,
  }))
  const runsQuery = createQuery(() => ({
    queryKey: ['runs', 5],
    queryFn: () => api.runs(5),
    staleTime: 15_000,
    refetchInterval: 15_000,
  }))
  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
    staleTime: 10_000,
  }))

  const browsers = $derived(browsersQuery.data ?? null)
  const config = $derived(configQuery.data ?? null)
  const latestRun = $derived(runsQuery.data?.runs?.[0] ?? null)
  const serverUrl = $derived(typeof window !== 'undefined' ? window.location.origin : '')

  type SettingsSection = 'agent' | 'browsers' | 'sources' | 'schedule' | 'pairing' | 'server'
  let section = $state<SettingsSection>('agent')
  const SECTIONS: [SettingsSection, string][] = [
    ['agent', 'Agent'],
    ['browsers', 'Browsers'],
    ['sources', 'Sources'],
    ['schedule', 'Schedule'],
    ['pairing', 'Pairing'],
    ['server', 'Server'],
  ]

  interface AcpAgent { id: string; label: string; command: string[]; path: string }
  interface AgentsResponse { configured: string[] | null; available: AcpAgent[] }
  let agents = $state<AgentsResponse | null>(null)
  let agentBusy = $state(false)
  let customCmd = $state('')
  const bridge = () => (window as unknown as { __linkinboxBridge?: string }).__linkinboxBridge ?? null

  async function loadAgents() {
    const b = bridge()
    if (b === null) return
    try {
      const res = await fetch(`${b}/acp/agents`)
      if (res.ok) agents = await res.json()
    } catch { /* bridge down */ }
  }
  async function pickAgent(command: string[]) {
    const b = bridge()
    if (b === null || agentBusy) return
    agentBusy = true
    try {
      await fetch(`${b}/acp/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      await loadAgents()
    } finally { agentBusy = false }
  }
  let acpOn = $state(false)
  void acpAvailable().then((ok) => { acpOn = ok; void loadAgents() })

  let pairCode = $state<string | null>(null)
  let pairExpiry = $state<string | null>(null)
  let pairError = $state('')
  let pairBusy = $state(false)

  async function genPairCode() {
    pairBusy = true
    pairError = ''
    try {
      const res = await api.pairCode()
      pairCode = res.code
      pairExpiry = res.expiresAt
    } catch (err) {
      pairError = err instanceof Error ? err.message : String(err)
    } finally {
      pairBusy = false
    }
  }

  async function refresh() {
    await Promise.all([
      browsersQuery.refetch(),
      configQuery.refetch(),
      runsQuery.refetch(),
    ])
    void queryClient
  }

  const CRON_HINT = m.cron_hint()

  function capsChips(a: { caps: { stealth: boolean; headless: boolean; persistentProfile: boolean } | null }) {
    if (!a.caps) return '—'
    const out: string[] = []
    if (a.caps.stealth) out.push('stealth')
    if (a.caps.headless) out.push('headless')
    if (a.caps.persistentProfile) out.push('profile')
    return out.join(' · ') || '—'
  }
</script>

<div class="settings settings-shell" data-testid="settings-view">
  <nav class="settings-nav" aria-label={m.settings_title()}>
    <div class="settings-nav-head">
      <h1 class="settings-title display">{m.settings_title()}</h1>
    </div>
    {#each SECTIONS as [id, label] (id)}
      <button
        type="button"
        class="settings-nav-item"
        class:is-active={section === id}
        onclick={() => (section = id)}
        data-testid={`settings-nav-${id}`}
      >{label}</button>
    {/each}
    <button type="button" class="settings-nav-item settings-nav-refresh" onclick={() => void refresh()}>{m.action_refresh()}</button>
  </nav>
  <div class="settings-body">

  <!-- Browser adapters -->
  {#if section === 'agent'}
  <section class="pane card" data-testid="settings-agent">
    <h2 class="card-title">Agent</h2>
    <p class="card-note">Pick the ACP agent binary the shell spawns for the in-app agent. Detected clients are listed automatically; use a custom command for anything else.</p>
    {#if !acpOn}
      <p class="meta">{m.assistant_not_configured()}</p>
    {:else if agents === null}
      <div class="skeleton" style="height: 60px;"></div>
    {:else}
      <ul class="agent-list">
        {#each agents.available as a (a.id)}
          {@const active = agents!.configured !== null && agents!.configured.join(' ') === a.command.join(' ')}
          <li>
            <button
              type="button"
              class="agent-option"
              class:is-active={active}
              disabled={agentBusy}
              onclick={() => void pickAgent(a.command)}
              data-testid={`agent-pick-${a.id}`}
            >
              <span class="agent-name">{a.label}</span>
              <code class="mono agent-cmd">{a.path} {a.command.slice(1).join(' ')}</code>
              {#if active}<span class="agent-active">active</span>{/if}
            </button>
          </li>
        {:else}
          <li class="meta">No known ACP clients found on PATH.</li>
        {/each}
      </ul>
      <div class="agent-custom">
        <input
          class="input"
          placeholder="custom command — e.g. maki acp"
          bind:value={customCmd}
          data-testid="agent-custom-input"
        />
        <button
          type="button"
          class="btn btn-sm"
          disabled={agentBusy || customCmd.trim() === ''}
          onclick={() => { void pickAgent(customCmd.trim().split(/\s+/)); customCmd = '' }}
          data-testid="agent-custom-save"
        >Use custom</button>
      </div>
      {#if agents.configured !== null}
        <p class="meta-faint">Configured: <code class="mono">{agents.configured.join(' ')}</code></p>
      {/if}
    {/if}
  </section>
  {/if}

  {#if section === 'browsers'}
  <section class="pane card" data-testid="settings-browsers">
    <h2 class="card-title">{m.settings_browsers()}</h2>
    <p class="card-note">{m.settings_browsers_note()}</p>
    {#if browsersQuery.isPending}
      <div class="skeleton" style="height: 80px;"></div>
    {:else if browsers == null}
      <p class="meta">{m.settings_browsers_unavailable()}</p>
    {:else}
      <table class="table">
        <thead>
          <tr><th>id</th><th>{m.th_kind()}</th><th>{m.th_caps()}</th><th>{m.th_roles()}</th><th>{m.th_health()}</th></tr>
        </thead>
        <tbody>
          {#each browsers.adapters as a (a.id)}
            <tr data-testid="adapter-row-{a.id}">
              <td class="mono">{a.id}</td>
              <td class="mono">{a.kind}</td>
              <td class="meta">{capsChips(a)}</td>
              <td class="meta">{a.roles.join(' + ') || '—'}{#if a.inEscalate} · {m.adapter_escalate()}{/if}</td>
              <td>
                {#if a.health.ok}
                  <span class="chip chip-state-enriched">{m.health_ok()}</span>
                {:else}
                  <span class="chip chip-state-errored" title={a.health.detail}>{m.health_fail()}</span>
                  <div class="meta adapter-detail">{a.health.detail}</div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if Object.keys(browsers.hostMappings).length > 0}
        <p class="meta host-map">
          {m.settings_host_overrides()}
          {#each Object.entries(browsers.hostMappings) as [host, adapter] (host)}
            <code class="mono">{host} → {adapter}</code>
          {/each}
        </p>
      {/if}
      <p class="meta">
        {m.settings_reader()} <code class="mono">{browsers.reader}</code> ·
        {m.settings_login()} <code class="mono">{browsers.login}</code>
        {#if browsers.escalate.length > 0}· {m.settings_escalate()} {browsers.escalate.join(' → ')}{/if}
      </p>
      <p class="meta-faint">{m.settings_refresh_note()}</p>
    {/if}
  </section>
  {/if}

  <!-- Sources -->
  {#if section === 'sources'}
  <section class="pane card" data-testid="settings-sources">
    <h2 class="card-title">{m.settings_sources()}</h2>
    <p class="card-note">{m.settings_sources_note_pre()} <code>[sources]</code> {m.settings_sources_note_post()}</p>
    {#if config}
      {#if config.sources.length > 0}
        <ul class="source-list">
          {#each config.sources as s (s)}
            <li class="mono">{s}</li>
          {/each}
        </ul>
      {:else}
        <p class="meta">{m.settings_no_sources_pre()} <code>[sources]</code> {m.settings_no_sources_post()}</p>
      {/if}
      <p class="meta">{m.settings_config_path()} <code class="mono">{config.configPath}</code></p>
    {:else}
      <p class="meta">{m.settings_config_unreadable_pre()} <code>linkinbox config</code>{m.settings_config_unreadable_post()}</p>
    {/if}
  </section>
  {/if}

  <!-- Schedule -->
  {#if section === 'schedule'}
  <section class="pane card" data-testid="settings-schedule">
    <h2 class="card-title">{m.settings_schedule()}</h2>
    <p class="card-note">{m.settings_schedule_note()}</p>
    <p class="meta">{m.settings_suggested()} <code class="mono">{CRON_HINT}</code></p>
    {#if latestRun}
      <p class="meta">
        {m.settings_last_run()} <code class="mono">#{latestRun.id} {latestRun.stage}</code>
        {timeAgo(latestRun.startedAt)}
        {#if latestRun.errorCount > 0}· {m.settings_last_run_errors({ count: latestRun.errorCount })}{/if}
        <button type="button" class="btn btn-sm btn-ghost" onclick={() => setUrl({ view: 'run', selected: null })}>{m.settings_view_run()}</button>
      </p>
    {:else}
      <p class="meta">{m.settings_last_run_none()}</p>
    {/if}
    <p class="meta-faint">{m.settings_next_run()}</p>
    <CopyButton text={CRON_HINT} label={m.copy_cron()} />
    <details class="legend">
      <summary class="meta">{m.settings_exit_codes()}</summary>
      <ul class="meta legend-list">
        <li><code>0</code> {m.exit_code_0()}</li>
        <li><code>2</code> {m.exit_code_2()}</li>
        <li><code>1</code> {m.exit_code_1()}</li>
        <li><code>3</code> {m.exit_code_3()}</li>
      </ul>
    </details>
  </section>
  {/if}

  <!-- Extension pairing -->
  {#if section === 'pairing'}
  <section class="pane card" data-testid="settings-pairing">
    <h2 class="card-title">{m.settings_pairing()}</h2>
    <p class="card-note">{m.settings_pairing_note()}</p>
    <div class="pair-row">
      <span class="meta">{m.settings_server_url()}</span>
      <code class="mono pair-url">{serverUrl}</code>
      <CopyButton text={serverUrl} />
    </div>
    {#if pairCode}
      <div class="pair-code" role="status" data-testid="pair-code">
        <code class="mono pair-code-value">{pairCode}</code>
        <p class="meta">{pairExpiry ? m.pair_expires({ time: timeAgo(pairExpiry) }) : m.pair_shown_once()}</p>
        <CopyButton text={pairCode} label={m.copy_code()} />
      </div>
    {:else}
      <button
        type="button"
        class="btn btn-sm"
        disabled={pairBusy}
        onclick={() => void genPairCode()}
        data-testid="gen-pair-code"
      >
        {pairBusy ? m.pair_generating() : m.pair_generate()}
      </button>
    {/if}
    {#if pairError}<p class="field-error">{pairError}</p>{/if}
    <p class="meta">{m.settings_pair_status()}</p>
    <details class="legend">
      <summary class="meta">{m.pair_how_title()}</summary>
      <p class="meta legend-list">
        {m.pair_how_body_pre()} <code>[capture] allowed_origins</code>{m.pair_how_body_post()}
      </p>
    </details>
  </section>
  {/if}

  <!-- Server -->
  {#if section === 'server'}
  <section class="pane card" data-testid="settings-server">
    <h2 class="card-title">{m.settings_server()}</h2>
    {#if config}
      <dl class="facts">
        <div class="fact"><dt>{m.fact_bind()}</dt><dd class="mono">{config.bind.hostname}:{config.bind.port}</dd></div>
        <div class="fact"><dt>{m.fact_api_token()}</dt><dd>{config.bind.tokenRequired ? m.token_required() : m.token_not_required()}</dd></div>
        <div class="fact"><dt>{m.fact_capture()}</dt><dd>{config.capture.tokenConfigured ? m.capture_enabled() : m.capture_disabled()}</dd></div>
        <div class="fact"><dt>{m.fact_data_dir()}</dt><dd class="mono">{config.dir}</dd></div>
      </dl>
      {#if config.capture.allowedOrigins.length > 0}
        <p class="meta">{m.settings_capture_origins()} {config.capture.allowedOrigins.join(', ')}</p>
      {/if}
      <CopyButton text={config.dir} label={m.copy_data_dir()} />
    {:else}
      <p class="meta">{m.settings_server_unavailable()}</p>
    {/if}
  </section>
  {/if}
  </div>
</div>

<style>
  .settings {
    max-width: 768px;
    margin: 0 auto;
    padding: 20px 20px 56px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    overflow-y: auto;
  }
  .settings-title {
    font-size: 22px;
  }
  .card-title {
    font-size: 15px;
    margin-bottom: 4px;
  }
  .card-note {
    font-size: 12.5px;
    color: var(--color-ink-faint);
    margin-bottom: 10px;
  }
  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .table th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-ink-faint);
    padding: 5px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .table td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--color-line);
    vertical-align: top;
  }
  .adapter-detail {
    font-size: 11.5px;
    max-width: 220px;
  }
  .host-map {
    margin: 6px 0;
  }
  .host-map code {
    margin-right: 10px;
  }
  .source-list {
    margin: 4px 0 8px;
    padding-left: 18px;
    font-size: 13px;
  }
  .pair-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .pair-url {
    font-size: 13px;
  }
  .pair-code {
    border: 1px solid var(--color-line);
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .pair-code-value {
    font-size: 20px;
    letter-spacing: 0.12em;
    font-weight: 700;
  }
  .legend {
    margin-top: 8px;
  }
  .legend-list {
    margin: 6px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 18px;
    margin: 4px 0 10px;
  }
  .fact {
    display: flex;
    gap: 8px;
    font-size: 12.5px;
  }
  .fact dt {
    color: var(--color-ink-faint);
    min-width: 90px;
    flex: none;
  }
  .fact dd {
    margin: 0;
  }
  .settings-shell {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .settings-nav {
    flex: none;
    width: 148px;
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-top: 18px;
  }
  .settings-nav-head {
    margin-bottom: 10px;
    padding: 0 10px;
  }
  .settings-nav-item {
    text-align: left;
    padding: 6px 10px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--color-ink-soft);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color 140ms var(--ease-out-expo),
      color 140ms var(--ease-out-expo);
  }
  .settings-nav-item:hover {
    color: var(--color-ink);
    background: var(--color-accent);
  }
  .settings-nav-item.is-active {
    background: var(--color-accent);
    color: var(--color-ink);
  }
  .settings-nav-refresh {
    margin-top: 14px;
    color: var(--color-ink-faint);
  }
  .settings-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .agent-list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .agent-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 9px;
    border: 1px solid var(--color-line);
    background: var(--color-surface-raised);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 140ms var(--ease-out-expo),
      background-color 140ms var(--ease-out-expo);
  }
  .agent-option:hover:not(:disabled) {
    border-color: var(--color-line-strong);
  }
  .agent-option.is-active {
    border-color: var(--color-accent-blue);
    background: var(--color-accent-wash);
  }
  .agent-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-ink);
    flex: none;
  }
  .agent-cmd {
    font-size: 11.5px;
    color: var(--color-ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .agent-active {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-accent-blue);
    flex: none;
  }
  .agent-custom {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .agent-custom .input {
    flex: 1;
    font-size: 12.5px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .meta {
    color: var(--color-ink-soft);
    font-size: 12.5px;
  }
  .meta-faint {
    color: var(--color-ink-faint);
    font-size: 12px;
  }
  .field-error {
    color: var(--color-state-errored, #b3261e);
    font-size: 12.5px;
  }
  @media (max-width: 759px) {
    .table thead {
      display: none;
    }
    .table,
    .table tbody,
    .table tr,
    .table td {
      display: block;
      width: 100%;
    }
    .table tr {
      border-bottom: 1px solid var(--color-line);
      padding: 8px 0;
    }
    .table td {
      border: none;
      padding: 2px 0;
    }
  }
</style>
