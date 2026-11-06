<script lang="ts">
  import Wrapper from './Wrapper.svelte'
  import Pipeline from '../../src/views/Pipeline.svelte'
  import type { UrlState } from '../../src/lib/urlState'

  let {
    url,
    setUrl,
  }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()
</script>

<Wrapper>
  <Pipeline {url} {setUrl} />
</Wrapper>
