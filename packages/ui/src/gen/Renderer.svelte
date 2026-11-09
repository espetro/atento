<script lang="ts">
  import type { Snippet } from 'svelte'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import type { UIElement } from './catalog'

  /**
   * GenUI renderer (P2.2): turns a validated `UIElement[]` tree into real
   * components. Generic catalog types render natively; unknown types resolve
   * through `parts` (Svelte snippets the host view provides — business logic
   * and handlers stay in the view, never in generated data).
   */
  let {
    nodes,
    parts = {},
    onAction,
  }: {
    nodes: UIElement[]
    parts?: Record<string, Snippet<[UIElement]>>
    /** Resolve `button` node actions by opaque id — the view maps ids to handlers. */
    onAction?: (actionId: string) => void
  } = $props()

  function md(text: string): string {
    const out = marked.parse(text, { async: false })
    return typeof out === 'string' ? DOMPurify.sanitize(out) : ''
  }
</script>

{#snippet Nodes(list: UIElement[])}
  {#each list as node, i (node.id ?? `${node.type}:${i}`)}
    {@render Node(node)}
  {/each}
{/snippet}

{#snippet Node(node: UIElement)}
  {@const p = (node.props ?? {}) as Record<string, any>}
  {#if node.type === 'section'}
    <section class="panel-section" id={node.id}>
      {#if p.title}<h3 class="section-title">{p.title}</h3>{/if}
      {#if p.note}<p class="meta-faint section-note">{p.note}</p>{/if}
      {@render Nodes(node.children ?? [])}
    </section>
  {:else if node.type === 'twoColumn'}
    <div class="gen-cols" style:--cols={String(p.cols ?? '2')}>
      {@render Nodes(node.children ?? [])}
    </div>
  {:else if node.type === 'markdown'}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
    <article class="markdown-body">{@html md(String(p.text ?? ''))}</article>
  {:else if node.type === 'button'}
    <button
      type="button"
      class="btn btn-sm"
      class:btn-primary={p.variant === 'primary'}
      class:btn-danger={p.variant === 'danger'}
      class:btn-ghost={p.variant === 'ghost'}
      onclick={() => onAction?.(String(p.action ?? ''))}
    >{p.label}</button>
  {:else if node.type === 'toolbar'}
    <div class="gen-toolbar">{@render Nodes(node.children ?? [])}</div>
  {:else if node.type === 'metric'}
    <div class="pane gen-metric">
      <div class="meta-faint">{p.title}</div>
      <div class="gen-metric-value" class:is-up={p.trend === 'up'} class:is-down={p.trend === 'down'}>{p.value}</div>
      {#if p.delta || p.description}<div class="meta">{p.delta ?? ''}{p.delta && p.description ? ' · ' : ''}{p.description ?? ''}</div>{/if}
    </div>
  {:else if node.type === 'chips'}
    <div class="gen-chips">
      {#each (p.items ?? []) as chip (chip.label)}
        <span class="chip chip-state-{chip.tone ?? 'default'}">{chip.label}</span>
      {/each}
    </div>
  {:else if node.type in parts}
    {@render parts[node.type]!(node)}
  {:else}
    {@render Nodes(node.children ?? [])}
  {/if}
{/snippet}

{@render Nodes(nodes)}

<style>
  /* Same semantics as the views' panel sections — kept here so generic
     `section` nodes render identically inside a GenUI layout. */
  .panel-section {
    padding-block: 4px 14px;
  }
  .panel-section + .panel-section {
    border-top: 1px solid var(--color-line);
    padding-top: 14px;
  }
  .section-title {
    font-size: 14px;
    margin-top: 14px;
  }
  .panel-section > .section-title:first-child {
    margin-top: 0;
  }
  .section-note {
    margin-bottom: 6px;
  }
  .gen-cols {
    display: grid;
    grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr));
    gap: 12px;
  }
  .gen-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .gen-metric {
    padding: 12px 14px;
  }
  .gen-metric-value {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-top: 2px;
  }
  .gen-metric-value.is-up {
    color: var(--color-ok);
  }
  .gen-metric-value.is-down {
    color: var(--color-bad);
  }
  .gen-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
