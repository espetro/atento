<script lang="ts">
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import {
    acpCancel,
    acpConfigure,
    acpPermission,
    acpPrompt,
    acpStatus,
    onAcpEvent,
    onAcpPermission,
    type AcpPermissionRequest,
    type AcpStatus,
  } from '../acp'
  import IconX from '~icons/lucide/x'
  import IconSparkles from '~icons/lucide/sparkles'
  import IconSendHorizontal from '~icons/lucide/send-horizontal'
  import { m } from '../../paraglide/messages.js'

  /**
   * ACP assistant panel (P3.4). Docked as a resizable pane on the right of
   * the shell — the parent mounts it conditionally. Rendered only when the
   * shell bridge exposes the /acp endpoints; hidden on plain web. The shell
   * owns the agent subprocess — the panel just sends prompts and renders
   * streamed session/update payloads.
   */
  let { onClose }: { onClose: () => void } = $props()

  interface Turn {
    role: 'user' | 'agent'
    text: string
    thought?: string
    streaming?: boolean
  }

  let status = $state<AcpStatus | null>(null)
  let turns = $state<Turn[]>([])
  let draft = $state('')
  let busy = $state(false)
  let pendingPermission = $state<AcpPermissionRequest | null>(null)
  let agentCmd = $state('')
  let error = $state('')
  let scrollEl = $state<HTMLElement | null>(null)

  $effect(() => {
    void acpStatus().then((s) => (status = s))
    const offEvents = onAcpEvent((update) => {
      const u = update as {
        sessionUpdate?: string
        content?: { type?: string; text?: string }
        error?: string
      }
      const kind = u.sessionUpdate
      if (kind === 'agent_message_chunk') {
        appendChunk(u.content?.text ?? '', 'agent')
      } else if (kind === 'agent_thought_chunk') {
        appendThought(u.content?.text ?? '')
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        appendChunk(`⚙ ${(u as { title?: string }).title ?? 'tool call'}`, 'agent')
      } else if (kind === 'end_turn' || kind === 'error') {
        busy = false
        const last = turns[turns.length - 1]
        if (last?.streaming) last.streaming = false
        if (kind === 'error') error = String(u.error ?? 'agent error')
      }
    })
    const offPerm = onAcpPermission((req) => {
      pendingPermission = req
      busy = false
    })
    return () => {
      offEvents()
      offPerm()
    }
  })

  $effect(() => {
    // Follow the stream.
    turns.length
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight })
  })

  function appendChunk(text: string, role: 'agent') {
    const last = turns[turns.length - 1]
    if (last?.role === role && last.streaming) {
      last.text += text
    } else {
      turns = [...turns, { role, text, streaming: true }]
    }
  }
  function appendThought(text: string) {
    const last = turns[turns.length - 1]
    if (last?.role === 'agent') {
      last.thought = (last.thought ?? '') + text
    }
  }

  function md(text: string): string {
    const out = marked.parse(text, { async: false })
    return typeof out === 'string' ? DOMPurify.sanitize(out) : ''
  }

  async function send() {
    const text = draft.trim()
    if (text === '' || busy) return
    error = ''
    draft = ''
    turns = [...turns, { role: 'user', text }]
    busy = true
    try {
      const res = await acpPrompt(text)
      if (res.ok === false) {
        busy = false
        error = res.error ?? m.assistant_error()
      }
    } catch (e) {
      busy = false
      error = String(e)
    }
  }

  function onComposerKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  async function saveCommand() {
    const cmd = agentCmd.trim().split(/\s+/).filter(Boolean)
    if (cmd.length === 0) return
    try {
      await acpConfigure(cmd)
      status = await acpStatus()
    } catch (e) {
      error = String(e)
    }
  }

  function answerPermission(optionId: string) {
    if (!pendingPermission) return
    void acpPermission(pendingPermission.requestId, optionId).catch(() => {})
    pendingPermission = null
    busy = true
  }
</script>

  <aside class="assistant" data-testid="assistant-drawer" aria-label={m.assistant_title()}>
    <header class="assistant-head">
      <span class="assistant-title"><IconSparkles /> {m.assistant_title()}</span>
      <button type="button" class="btn btn-ghost btn-icon" aria-label={m.aria_close()} onclick={onClose}>
        <IconX />
      </button>
    </header>

    {#if status && !status.configured}
      <div class="assistant-setup">
        <p class="meta">{m.assistant_not_configured()}</p>
        <input
          class="input"
          bind:value={agentCmd}
          placeholder={m.assistant_agent_placeholder()}
          data-testid="assistant-agent-input"
        />
        <button type="button" class="btn btn-sm btn-primary" onclick={saveCommand}>
          {m.assistant_save_agent()}
        </button>
      </div>
    {/if}

    <div class="assistant-scroll scroll-thin" bind:this={scrollEl}>
      {#each turns as turn, i (i)}
        <div class="turn turn-{turn.role}">
          {#if turn.role === 'agent'}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized -->
            <div class="agent-bubble"><div class="markdown-body">{@html md(turn.text)}</div></div>
            {#if turn.thought}<details class="thought"><summary>{m.assistant_thought()}</summary><p>{turn.thought}</p></details>{/if}
          {:else}
            <div class="user-bubble">{turn.text}</div>
          {/if}
        </div>
      {:else}
        <div class="assistant-empty">
          <div class="empty-glyph" aria-hidden="true"><IconSparkles /></div>
          <p class="display empty-title">{m.assistant_title()}</p>
          <p class="meta-faint">{m.assistant_empty()}</p>
        </div>
      {/each}
      {#if busy}
        <p class="meta-faint thinking">{m.assistant_thinking()}</p>
      {/if}
    </div>

    {#if pendingPermission}
      <div class="perm-banner" role="alert">
        <p class="meta">{m.assistant_permission()}</p>
        <div class="perm-actions">
          <button type="button" class="btn btn-sm btn-primary" onclick={() => answerPermission('allow')}>{m.action_confirm()}</button>
          <button type="button" class="btn btn-sm" onclick={() => answerPermission('reject')}>{m.action_cancel()}</button>
        </div>
      </div>
    {/if}

    {#if error}
      <p class="assistant-error notice-bad" role="alert">{error}</p>
    {/if}

    <footer class="assistant-foot">
      <textarea
        class="textarea composer"
        rows="2"
        bind:value={draft}
        onkeydown={onComposerKey}
        placeholder={m.assistant_placeholder()}
        data-testid="assistant-composer"
      ></textarea>
      <div class="composer-row">
        {#if busy}
          <button type="button" class="btn btn-sm" onclick={() => void acpCancel()}>{m.action_cancel()}</button>
        {/if}
        <button
          type="button"
          class="btn btn-sm btn-primary"
          disabled={busy || draft.trim() === ''}
          onclick={send}
          data-testid="assistant-send"
        >
          <IconSendHorizontal /> {m.assistant_send()}
        </button>
      </div>
    </footer>
  </aside>

<style>
  .assistant {
    height: 100%;
    min-height: 0;
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--color-surface-raised);
  }
  .assistant-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .assistant-title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
    font-size: 13.5px;
  }
  .assistant-title :global(svg) {
    color: var(--color-accent-blue);
  }
  .assistant-setup {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .assistant-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .assistant-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    margin-top: 32px;
  }
  .empty-title {
    font-size: 17px;
  }
  .turn-agent .markdown-body {
    font-size: 13px;
  }
  .user-bubble {
    background: var(--color-accent-wash);
    border-radius: 14px 14px 4px 14px;
    padding: 8px 12px;
    font-size: 13px;
    max-width: 85%;
    margin-left: auto;
    white-space: pre-wrap;
  }
  .agent-bubble {
    background: var(--color-surface-sunken);
    border-radius: 14px 14px 14px 4px;
    padding: 8px 12px;
    max-width: 92%;
  }
  .thinking {
    padding-inline: 4px;
  }
  .thought {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .perm-banner {
    margin: 8px 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-line-strong);
    border-radius: 10px;
    background: var(--color-surface-sunken);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .perm-actions {
    display: flex;
    gap: 6px;
  }
  .assistant-error {
    margin: 0 12px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 12.5px;
  }
  .assistant-foot {
    border-top: 1px solid var(--color-line);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .composer {
    font-size: 13px;
    resize: none;
    border-radius: 12px;
  }
  .composer-row {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
