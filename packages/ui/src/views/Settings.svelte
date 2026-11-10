<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import { timeAgo } from '../lib/format'
  import CopyButton from '../lib/components/CopyButton.svelte'
  import AgentSettings from './AgentSettings.svelte'
  import { m } from '../paraglide/messages.js'
  import type { UrlState } from '../lib/urlState'
  import { SETTINGS_GROUPS, settingsSection } from '../lib/settingsNav'

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

  const section = $derived($settingsSection)
  const sectionLabel = $derived(
    SETTINGS_GROUPS.flatMap((g) => g.items).find(([id]) => id === section)?.[1] ?? '',
  )

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
  <div class="settings-col">
    <header class="settings-head">
      <h1 class="settings-title display">{m.settings_title()}</h1>
      <button type="button" class="btn btn-sm btn-ghost" onclick={() => void refresh()}>{m.action_refresh()}</button>
    </header>
    <h2 class="section-title">{sectionLabel}</h2>

    {#if section === 'agent'}
      <AgentSettings />
    {/if}

    {#if section === 'browsers'}
    <section class="card" data-testid="settings-browsers">
      <p class="card-note">{m.settings_browsers_note()}</p>
      {#if browsersQuery.isPending}
        <div class="row"><div class="skeleton" style="height: 80px; width: 100%;"></div></div>
      {:else if browsers == null}
        <div class="row"><div class="row-desc">{m.settings_browsers_unavailable()}</div></div>
      {:else}
        <div class="table-wrap">
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
        </div>
        {#each Object.entries(browsers.hostMappings) as [host, adapter] (host)}
          <div class="row"><div class="row-title">{m.settings_host_overrides()} <code class="mono">{host}</code></div><div class="row-ctl"><code class="mono">{adapter}</code></div></div>
        {/each}
        <div class="row"><div class="row-title">{m.settings_reader()}</div><div class="row-ctl"><code class="mono">{browsers.reader}</code></div></div>
        <div class="row"><div class="row-title">{m.settings_login()}</div><div class="row-ctl"><code class="mono">{browsers.login}</code></div></div>
        {#if browsers.escalate.length > 0}
          <div class="row"><div class="row-title">{m.settings_escalate()}</div><div class="row-ctl"><code class="mono">{browsers.escalate.join(' → ')}</code></div></div>
        {/if}
        <p class="card-note card-foot">{m.settings_refresh_note()}</p>
      {/if}
    </section>
    {/if}

    {#if section === 'sources'}
    <section class="card" data-testid="settings-sources">
      <p class="card-note">{m.settings_sources_note_pre()} <code>[sources]</code> {m.settings_sources_note_post()}</p>
      {#if config}
        {#each config.sources as s (s)}
          <div class="row"><code class="mono row-title">{s}</code></div>
        {:else}
          <div class="row"><div class="row-desc">{m.settings_no_sources_pre()} <code>[sources]</code> {m.settings_no_sources_post()}</div></div>
        {/each}
        <div class="row"><div class="row-title">{m.settings_config_path()}</div><div class="row-ctl"><code class="mono">{config.configPath}</code></div></div>
      {:else}
        <div class="row"><div class="row-desc">{m.settings_config_unreadable_pre()} <code>atento config</code>{m.settings_config_unreadable_post()}</div></div>
      {/if}
    </section>
    {/if}

    {#if section === 'schedule'}
    <section class="card" data-testid="settings-schedule">
      <p class="card-note">{m.settings_schedule_note()}</p>
      <div class="row">
        <div class="row-text"><div class="row-title">{m.settings_suggested()}</div><code class="row-desc mono">{CRON_HINT}</code></div>
        <div class="row-ctl"><CopyButton text={CRON_HINT} label={m.copy_cron()} /></div>
      </div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{m.settings_last_run()}</div>
          <div class="row-desc">
            {#if latestRun}
              <code class="mono">#{latestRun.id} {latestRun.stage}</code> {timeAgo(latestRun.startedAt)}
              {#if latestRun.errorCount > 0}· {m.settings_last_run_errors({ count: latestRun.errorCount })}{/if}
            {:else}
              {m.settings_last_run_none()}
            {/if}
          </div>
        </div>
        {#if latestRun}
          <div class="row-ctl"><button type="button" class="btn btn-sm" onclick={() => setUrl({ view: 'run', selected: null })}>{m.settings_view_run()}</button></div>
        {/if}
      </div>
      <div class="row"><div class="row-desc">{m.settings_next_run()}</div></div>
      <details class="row legend">
        <summary class="row-title">{m.settings_exit_codes()}</summary>
        <ul class="meta legend-list">
          <li><code>0</code> {m.exit_code_0()}</li>
          <li><code>2</code> {m.exit_code_2()}</li>
          <li><code>1</code> {m.exit_code_1()}</li>
          <li><code>3</code> {m.exit_code_3()}</li>
        </ul>
      </details>
    </section>
    {/if}

    {#if section === 'pairing'}
    <section class="card" data-testid="settings-pairing">
      <p class="card-note">{m.settings_pairing_note()}</p>
      <div class="row">
        <div class="row-text"><div class="row-title">{m.settings_server_url()}</div><code class="row-desc mono">{serverUrl}</code></div>
        <div class="row-ctl"><CopyButton text={serverUrl} /></div>
      </div>
      <div class="row">
        {#if pairCode}
          <div class="row-text" role="status" data-testid="pair-code">
            <code class="mono pair-code-value">{pairCode}</code>
            <div class="row-desc">{pairExpiry ? m.pair_expires({ time: timeAgo(pairExpiry) }) : m.pair_shown_once()}</div>
          </div>
          <div class="row-ctl"><CopyButton text={pairCode} label={m.copy_code()} /></div>
        {:else}
          <div class="row-text"><div class="row-title">Pairing code</div><div class="row-desc">{m.settings_pair_status()}</div></div>
          <div class="row-ctl">
            <button type="button" class="btn btn-sm" disabled={pairBusy} onclick={() => void genPairCode()} data-testid="gen-pair-code">
              {pairBusy ? m.pair_generating() : m.pair_generate()}
            </button>
          </div>
        {/if}
      </div>
      {#if pairError}<div class="row"><p class="field-error">{pairError}</p></div>{/if}
      <details class="row legend">
        <summary class="row-title">{m.pair_how_title()}</summary>
        <p class="meta legend-list">{m.pair_how_body_pre()} <code>[capture] allowed_origins</code>{m.pair_how_body_post()}</p>
      </details>
    </section>
    {/if}

    {#if section === 'server'}
    <section class="card" data-testid="settings-server">
      {#if config}
        <div class="row"><div class="row-title">{m.fact_bind()}</div><div class="row-ctl"><code class="mono">{config.bind.hostname}:{config.bind.port}</code></div></div>
        <div class="row"><div class="row-title">{m.fact_api_token()}</div><div class="row-ctl">{config.bind.tokenRequired ? m.token_required() : m.token_not_required()}</div></div>
        <div class="row"><div class="row-title">{m.fact_capture()}</div><div class="row-ctl">{config.capture.tokenConfigured ? m.capture_enabled() : m.capture_disabled()}</div></div>
        <div class="row"><div class="row-title">{m.fact_data_dir()}</div><div class="row-ctl"><code class="mono">{config.dir}</code><CopyButton text={config.dir} label={m.copy_data_dir()} /></div></div>
        {#if config.capture.allowedOrigins.length > 0}
          <div class="row"><div class="row-title">{m.settings_capture_origins()}</div><div class="row-ctl">{config.capture.allowedOrigins.join(', ')}</div></div>
        {/if}
      {:else}
        <div class="row"><div class="row-desc">{m.settings_server_unavailable()}</div></div>
      {/if}
    </section>
    {/if}
  </div>
</div>

<style>
  .settings {
    height: 100%;
    overflow-y: auto;
    padding: 40px 24px 72px;
  }
  .settings-col {
    max-width: 680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .settings-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 18px;
  }
  .settings-title {
    font-size: 28px;
  }
  .section-title {
    font-size: 15px;
    font-weight: 600;
    padding-left: 2px;
  }
  .card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .card-note {
    font-size: 12.5px;
    color: var(--color-ink-faint);
    padding: 12px 18px;
    border-bottom: 1px solid var(--color-line);
  }
  .card-foot {
    border-bottom: none;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 18px;
    min-height: 56px;
  }
  .row + .row {
    border-top: 1px solid var(--color-line);
  }
  .row-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row-title {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--color-ink);
  }
  .row-desc {
    font-size: 12px;
    color: var(--color-ink-faint);
    overflow-wrap: anywhere;
  }
  .row-ctl {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--color-ink-soft);
    max-width: 60%;
    overflow-wrap: anywhere;
  }
  .table-wrap {
    overflow-x: auto;
    padding: 4px 10px;
  }
  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .table th {
    text-align: left;
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-ink-faint);
    padding: 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .table td {
    padding: 9px 8px;
    border-bottom: 1px solid var(--color-line);
    vertical-align: top;
  }
  .table tr:last-child td {
    border-bottom: none;
  }
  .adapter-detail {
    font-size: 11.5px;
    max-width: 220px;
  }
  .pair-code-value {
    font-size: 20px;
    letter-spacing: 0.12em;
    font-weight: 700;
  }
  .legend {
    display: block;
  }
  .legend summary {
    cursor: pointer;
  }
  .legend-list {
    margin: 8px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .meta {
    color: var(--color-ink-soft);
    font-size: 12.5px;
  }
  .field-error {
    color: var(--color-state-errored, #b3261e);
    font-size: 12.5px;
  }
  @media (max-width: 759px) {
    .row {
      flex-wrap: wrap;
    }
    .row-ctl {
      max-width: 100%;
    }
  }
</style>
