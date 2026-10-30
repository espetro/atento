<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { createQueryClient } from './lib/api'
  import { parseUrlState, toUrlState, type UrlState } from './lib/urlState'
  import Dock from './views/Dock.svelte'
  import Inbox from './views/Inbox.svelte'
  import Pipeline from './views/Pipeline.svelte'
  import Sweep from './views/Sweep.svelte'
  import Metrics from './views/Metrics.svelte'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))

  function setUrl(next: Partial<UrlState>) {
    url = { ...url, ...next }
    const qs = toUrlState(url).toString()
    history.pushState(null, '', qs ? `?${qs}` : window.location.pathname)
  }

  window.addEventListener('popstate', () => {
    url = parseUrlState(new URLSearchParams(window.location.search))
  })
</script>

<QueryClientProvider client={queryClient}>
  <div class="app-shell">
    <main class="flex-1 overflow-y-auto bg-base-100 text-base-content overflow-x-hidden">
      {#if url.view === 'sweep'}
        <Sweep />
      {:else if url.view === 'metrics'}
        <Metrics />
      {:else if url.view === 'pipeline'}
        <Pipeline {url} {setUrl} />
      {:else}
        <Inbox {url} {setUrl} />
      {/if}
    </main>
    <Dock view={url.view} onNavigate={(view) => setUrl({ view, selected: null })} />
  </div>
</QueryClientProvider>
