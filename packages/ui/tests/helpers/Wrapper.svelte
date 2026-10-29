<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { createQueryClient } from '../../src/lib/api'
  import type { Snippet } from 'svelte'

  let { children }: { children: Snippet } = $props()
  const queryClient = createQueryClient()
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
