<script lang="ts">
  import { onMount } from 'svelte'
  import { useQueryClient } from '@tanstack/svelte-query'
  import { startEvents, type SseEvent } from '../lib/events'

  /**
   * Opens the single /api/events stream for the session and maps each SSE
   * family onto query invalidation. Renders nothing.
   */
  const queryClient = useQueryClient()

  onMount(() => {
    const stop = startEvents((e: SseEvent) => {
      if (e.kind === 'link') {
        void queryClient.invalidateQueries({ queryKey: ['links'] })
        void queryClient.invalidateQueries({ queryKey: ['link'] })
        void queryClient.invalidateQueries({ queryKey: ['collections-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['pipeline'] })
      } else if (e.kind === 'run') {
        void queryClient.invalidateQueries({ queryKey: ['runs'] })
        void queryClient.invalidateQueries({ queryKey: ['collections-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['links'] })
      } else {
        void queryClient.invalidateQueries({ queryKey: ['links'] })
        void queryClient.invalidateQueries({ queryKey: ['collections-summary'] })
      }
    })
    return stop
  })
</script>
