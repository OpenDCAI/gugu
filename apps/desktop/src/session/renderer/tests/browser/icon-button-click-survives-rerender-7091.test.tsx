/**
 * 一屏几块时,没在看的那块点「关闭这一块」(×)第一下没反应,要点第二下(#7091,10-10 测试版实测两轮都这样)。
 * 按下那一刻那块被设成正看着的,整组控制重渲染;图标每渲染一次就把 `<svg>` 里的 `<path>` 换新 ——
 * 按下落在旧 path、抬起落在新 path,浏览器不发 click。
 *
 * 真 Chromium、真鼠标(vitest browser 的 userEvent 走 CDP 按下 / 抬起,click 由浏览器自己合成),真图标组件;
 * 「按下就重渲染」照真块的 onPointerDownCapture 搭。
 */
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { X } from '@/lib/icons';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

/** 一块:在里面按下 = 看这一块,于是整块(连同右上那颗 ×)重渲染一次。 */
function Block({ onClose }: { onClose: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <div onPointerDownCapture={() => setFocused(true)} data-focused={focused ? '' : undefined}>
      <button type="button" aria-label="关闭这一块" onClick={onClose} style={{ display: 'flex', width: 24, height: 24, padding: 5 }}>
        <X size={14} />
      </button>
    </div>
  );
}

it('an icon button whose block re-renders on press still gets its first click', async () => {
  let closes = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Block onClose={() => (closes += 1)} />);
  const container = host;
  await until('icon drawn', () => container.querySelector('svg path') !== null);
  const path = container.querySelector<SVGPathElement>('svg path')!;

  // 按在图标的笔画上(× 的中心是两笔交叉处),和真人点 × 一样。
  await userEvent.click(path);

  // 结果先判:第一下就点到了。
  expect(closes, 'first click on the × reaches its handler').toBe(1);
  expect(container.querySelector('[data-focused]'), 'the press re-rendered the block').not.toBeNull();
  expect(container.querySelector('svg path'), 'the icon keeps its drawn path across the re-render').toBe(path);
});
