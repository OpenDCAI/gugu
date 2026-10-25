import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { until } from '../../../../../../../tests/support/awaitCondition';

// #6629:常驻但隐藏的面里的加载态不许逐帧改 SVG —— 在役实例里两个看不见的「Loading chat…」
// 让渲染进程按刷新率整条管线空跑。读数 = 接下来 N 个真实渲染帧里,动画画布上的属性改写次数。
// 帧由本文件自己数(模块加载时抓的原生 rAF),不靠墙钟。

const nativeRaf = window.requestAnimationFrame.bind(window);
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n;
    const tick = () => (--left <= 0 ? resolve() : nativeRaf(tick));
    nativeRaf(tick);
  });

async function canvasWritesOver(surface: HTMLElement, n: number): Promise<number> {
  const canvas = surface.querySelector('[data-testid="loading-indicator-canvas"]');
  if (!canvas) throw new Error('loading canvas not mounted');
  let writes = 0;
  const observer = new MutationObserver((records) => {
    writes += records.length;
  });
  observer.observe(canvas, { attributes: true, subtree: true });
  await frames(n);
  observer.disconnect();
  return writes;
}

const hide = (el: HTMLElement) => {
  Object.assign(el.style, RETAINED_SURFACE_HIDDEN_STYLE);
};
const show = (el: HTMLElement) => {
  el.removeAttribute('style');
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

async function mount(surface: HTMLElement) {
  root = createRoot(surface);
  root.render(<LoadingIndicator ariaLabel="Loading chat" label="Loading chat" />);
  await until('animation svg mounted', () => surface.querySelector('[data-testid="loading-indicator-canvas"] svg') !== null);
}

describe('LoadingIndicator stops animating while its surface is hidden (#6629)', () => {
  it('animates when visible, stops when the surface is retained-hidden, resumes when shown', async () => {
    host = document.createElement('div');
    host.style.position = 'relative';
    host.style.height = '200px';
    document.body.appendChild(host);
    const surface = document.createElement('div');
    host.appendChild(surface);
    await mount(surface);

    // 阳控:同一个读数在可见时必须读到动画在画,否则下面的 0 什么也证明不了。
    expect(await canvasWritesOver(surface, 30)).toBeGreaterThan(0);

    hide(surface);
    await frames(2); // 让暂停前已排进来的那一帧落地
    expect(await canvasWritesOver(surface, 30)).toBe(0);

    show(surface);
    expect(await canvasWritesOver(surface, 30)).toBeGreaterThan(0);
  });

  it('never starts when it mounts inside an already hidden surface', async () => {
    host = document.createElement('div');
    host.style.position = 'relative';
    host.style.height = '200px';
    document.body.appendChild(host);
    const surface = document.createElement('div');
    hide(surface);
    host.appendChild(surface);
    await mount(surface);

    expect(await canvasWritesOver(surface, 30)).toBe(0);

    show(surface);
    expect(await canvasWritesOver(surface, 30)).toBeGreaterThan(0);
  });
});
