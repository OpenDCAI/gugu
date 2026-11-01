/** @jsxImportSource solid-js */
import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility';
import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { gridLoader, gridLoaderCells } from './grid-loader.css';

/**
 * 3×3 点阵 —— 「在跑」的那个记号(owner 2026-10-27 原型,照 assistant-ui Elements 的 Loader)。动画全在 CSS 里
 * (grid-loader.css.ts,合成器上跑);这里只管「看不见就停」:滚出视口或窗口不可见时暂停,与 ShimmerText 同一道开关。
 */
export function GridLoader() {
  const [visible, setVisible] = createSignal(true);
  let host!: HTMLSpanElement;
  onMount(() => onCleanup(observeAnimationViewport(host, setVisible)));
  return (
    <span ref={host} class={gridLoader} aria-hidden="true" data-slot="grid-loader"
      style={visible() ? undefined : { '--chat-shimmer-viewport-paused': 'paused' }}>
      <For each={gridLoaderCells}>{(cell) => <i class={cell} />}</For>
    </span>
  );
}
