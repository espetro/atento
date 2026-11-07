<script lang="ts">
  import { copyText } from '../lib/format'

  let { text, label = 'copy', class: cls = '' }: { text: string; label?: string; class?: string } =
    $props()

  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function onCopy() {
    const ok = await copyText(text)
    if (!ok) return
    copied = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied = false), 1500)
  }
</script>

<button
  type="button"
  class="btn btn-sm btn-ghost {cls}"
  onclick={onCopy}
  aria-live="polite"
  data-testid="copy-button"
>
  {copied ? 'copied' : label}
</button>
