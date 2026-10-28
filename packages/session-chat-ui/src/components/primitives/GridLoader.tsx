/** @jsxImportSource solid-js */
import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { gridLoader, gridLoaderCell, gridLoaderCellOn } from './grid-loader.css';

/**
 * 3×3 点阵 —— 「在跑」的那个记号(owner 2026-10-27 原型,照 assistant-ui Elements 的 Loader):每次亮 3 个点,
 * 120ms 走一步,9 步一圈;亮 0.9、暗 0.15,透明度过渡 300ms。顺序是从它页面上逐帧读出来的。
 * 减少动态效果时停在第一帧(样式里关掉过渡,这里不再走)。
 */
const FRAMES = ['045', '048', '348', '378', '237', '267', '126', '156', '015'];

export function GridLoader() {
  const [frame, setFrame] = createSignal(0);
  onMount(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <span class={gridLoader} aria-hidden="true" data-slot="grid-loader">
      <For each={[0, 1, 2, 3, 4, 5, 6, 7, 8]}>
        {(cell) => <i class={gridLoaderCell} classList={{ [gridLoaderCellOn]: FRAMES[frame()].includes(String(cell)) }} />}
      </For>
    </span>
  );
}
