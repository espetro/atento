<script lang="ts">
  /**
   * The assistant's face. Pure SVG + CSS, no animation runtime.
   * `state` drives the mood; idle blinks on a timer, and the eyes follow the
   * pointer when `track` is set. Colour comes from `currentColor`.
   */
  export type PersonaState = 'idle' | 'listening' | 'thinking' | 'working' | 'happy' | 'error' | 'sleeping'

  let {
    state: mood = 'idle',
    size = 24,
    track = false,
  }: { state?: PersonaState; size?: number; track?: boolean } = $props()

  let gx = $state(0)
  let gy = $state(0)

  $effect(() => {
    if (!track || mood === 'sleeping') return
    const move = (e: PointerEvent) => {
      const dx = e.clientX / window.innerWidth - 0.5
      const dy = e.clientY / window.innerHeight - 0.5
      gx = Math.max(-1, Math.min(1, dx * 2)) * 2.2
      gy = Math.max(-1, Math.min(1, dy * 2)) * 1.6
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  })
</script>

<svg
  class="persona persona-{mood}"
  viewBox="14 10 76 76"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  data-testid="persona"
  data-state={mood}
>
  <g class="face" style="--gx:{gx}px; --gy:{gy}px">
    <!-- brows / lashes: short curls above each eye -->
    <path class="brow brow-l" d="M25 29 Q33 21 42 27" />
    <path class="brow brow-r" d="M58 27 Q67 21 75 29" />
    <g class="eyes">
      <circle class="eye eye-l" cx="34" cy="41" r="4.6" fill="currentColor" stroke="none" />
      <circle class="eye eye-r" cx="66" cy="41" r="4.6" fill="currentColor" stroke="none" />
    </g>
    <!-- nose and mouth: one stroke, like a hand-drawn "L" -->
    <path class="mouth" d="M48 48 L44 66 L62 70" />
  </g>
  {#if mood === 'thinking'}
    <g class="dots" fill="currentColor" stroke="none">
      <circle cx="80" cy="12" r="3" /><circle cx="90" cy="8" r="2.2" /><circle cx="97" cy="4" r="1.6" />
    </g>
  {/if}
  {#if mood === 'sleeping'}
    <text class="zz" x="76" y="16" fill="currentColor" stroke="none" font-size="22" font-weight="700">z</text>
  {/if}
</svg>

<style>
  .persona {
    display: block;
    flex: none;
    overflow: visible;
  }
  .face {
    transform-box: fill-box;
    transform-origin: center;
  }
  .eyes {
    transform: translate(var(--gx, 0), var(--gy, 0));
    transition: transform 160ms var(--ease-out-expo, ease-out);
  }
  .eye {
    transform-box: fill-box;
    transform-origin: center;
    animation: persona-blink 5.2s infinite;
  }
  .eye-r {
    animation-delay: 0.06s;
  }
  .brow {
    transition: transform 220ms var(--ease-out-expo, ease-out);
  }

  .persona-listening .brow {
    transform: translateY(-3px);
  }
  .persona-listening .eye {
    transform: scale(1.25);
    animation: none;
  }

  .persona-thinking .eyes {
    transform: translate(3px, -4px);
    animation: persona-think 2.4s ease-in-out infinite;
  }
  .persona-thinking .brow-l {
    transform: translateY(-3px) rotate(-6deg);
  }
  .persona-thinking .dots circle {
    animation: persona-dot 1.4s ease-in-out infinite;
  }
  .persona-thinking .dots circle:nth-child(2) {
    animation-delay: 0.2s;
  }
  .persona-thinking .dots circle:nth-child(3) {
    animation-delay: 0.4s;
  }

  .persona-working .eyes {
    animation: persona-scan 1.6s ease-in-out infinite;
  }
  .persona-working .eye {
    animation: none;
  }
  .persona-working .mouth {
    animation: persona-hum 0.9s ease-in-out infinite;
  }

  .persona-happy .eye {
    transform: scaleY(0.45);
    animation: none;
  }
  .persona-happy .mouth {
    d: path('M44 56 L44 66 Q54 76 66 64');
  }

  .persona-error .eye {
    transform: scale(0.8);
    animation: none;
  }
  .persona-error .brow-l {
    transform: translateY(3px) rotate(8deg);
  }
  .persona-error .brow-r {
    transform: translateY(3px) rotate(-8deg);
  }
  .persona-error .mouth {
    d: path('M44 70 Q54 60 66 70');
  }

  .persona-sleeping .eye {
    transform: scaleY(0.12);
    animation: none;
  }
  .persona-sleeping .zz {
    animation: persona-dot 2.4s ease-in-out infinite;
  }

  @keyframes persona-blink {
    0%, 93%, 100% { transform: scaleY(1); }
    96% { transform: scaleY(0.1); }
  }
  @keyframes persona-think {
    0%, 100% { transform: translate(3px, -4px); }
    50% { transform: translate(-3px, -4px); }
  }
  @keyframes persona-scan {
    0%, 100% { transform: translateX(-3px); }
    50% { transform: translateX(3px); }
  }
  @keyframes persona-hum {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(1.5px); }
  }
  @keyframes persona-dot {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .eye,
    .eyes,
    .mouth,
    .dots circle,
    .zz {
      animation: none !important;
    }
  }
</style>
