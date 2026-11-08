<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import { timeAgo } from '../lib/format'
  import CopyButton from '../components/CopyButton.svelte'
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

<div class="settings" data-testid="settings-view">
  <header class="settings-head">
    <h1 class="settings-title">{m.settings_title()}</h1>
    <button type="button" class="btn btn-sm" onclick={() => void refresh()}>{m.action_refresh()}</button>
  </header>

  <!-- Browser adapters -->
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

  <!-- Sources -->
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

  <!-- Schedule -->
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

  <!-- Extension pairing -->
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

  <!-- Server -->
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
  .settings-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
