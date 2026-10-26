/**
 * #6699 Windows 标题栏行属于窗口外框:模态开着时它也不被盖住,整行点得到、拖得动。
 *
 * 修之前 Sheet(咕咕所有模态的原语)的遮罩与视口 `fixed inset-0`、z 在 --z-modal:盖住标题栏行,窗口按钮不可点;
 * 它们还退订了拖拽,而 Electron 的拖拽区按文档顺序做矩形相减 —— 遮罩一铺过标题栏行,模态期间窗口就拖不动。
 * 现在全窗口层挂 `.gg-window-layer`(tokens.css @@@window-layer),从标题栏行下沿铺起。
 *
 * 真 Chromium、真 CSS、真窗口 chrome(WindowControls)、真 Sheet。判:
 *   · 遮罩、视口的上沿 = 标题栏行下沿(拖拽区的矩形相减由盒子决定,盒子不进这一行,行的拖拽区就还在);
 *   · 沿标题栏行取几个点,最上层都是标题栏自己;窗口关闭钮点得到;
 *   · 卡片按整窗写的上限(`calc(100dvh - 32px)`)在矮一截的层里也不顶回标题栏。
 * `other`(不画标题栏行)那一格:层从窗口顶沿铺起,几何不变 —— 规则只在有这一行时起作用的阴性对照。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { WindowControls } from '@/components/WindowControls';
import { Sheet } from '@/components/ui/Sheet';
import '@/i18n';
import {
  windowControlsWidth,
  windowTitlebarHeight,
  type RendererPlatform,
} from '@/lib/window-chrome';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

let root: Root | null = null;
let host: HTMLElement | null = null;

/** main.tsx 开机时落的那几样(平台属性 + 两个几何 token),同一套函数算。 */
function applyPlatform(platform: RendererPlatform): void {
  const html = document.documentElement;
  html.dataset.platform = platform;
  if (platform === 'win') html.dataset.windowTitlebar = 'row';
  else delete html.dataset.windowTitlebar;
  html.style.setProperty('--titlebar-controls-width', `${windowControlsWidth(platform)}px`);
  html.style.setProperty('--window-titlebar-height', `${windowTitlebarHeight(platform)}px`);
}

function hitInside(x: number, y: number, el: Element): boolean {
  const hit = document.elementFromPoint(x, y);
  return hit !== null && el.contains(hit);
}

beforeEach(async () => {
  // 矮窗口:卡片按整窗写的上限在这里会比层高,判得出「顶回标题栏」。
  await page.viewport(1000, 560);
  Object.assign(window, {
    desktopWindow: {
      minimize: () => undefined,
      maximize: () => undefined,
      close: () => undefined,
      isMaximized: async () => false,
      onMaximizedChange: () => () => undefined,
      getChromeLabels: async () => ({ minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' }),
    },
  });
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  const html = document.documentElement;
  delete html.dataset.platform;
  delete html.dataset.windowTitlebar;
  html.style.removeProperty('--titlebar-controls-width');
  html.style.removeProperty('--window-titlebar-height');
  Reflect.deleteProperty(window, 'desktopWindow');
});

it.each(['win', 'other'] as const)('%s: an open Sheet lies below the title bar row and leaves the whole row reachable', async (platform) => {
  applyPlatform(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <>
      <WindowControls
        activeTab="chats"
        mobile={false}
        activeChatId={null}
        chats={[]}
        sessionHostAvailable
        onSelectTab={() => undefined}
        onOpenChat={() => undefined}
        onNewAgent={() => undefined}
        onOpenSettings={() => undefined}
      />
      <Sheet onClose={() => undefined} desktopWidth="480px" desktopMaxHeight="calc(100dvh - 32px)" ariaLabel="probe sheet">
        <div style={{ height: 2000 }}>tall content</div>
      </Sheet>
    </>
  );
  await until('sheet card mounted', () => document.querySelector('.gg-sheet-content') != null);

  const row = windowTitlebarHeight(platform);
  const backdrop = document.querySelector<HTMLElement>('.gg-sheet-backdrop')!;
  const viewport = document.querySelector<HTMLElement>('.gg-sheet-viewport')!;
  const card = document.querySelector<HTMLElement>('.gg-sheet-content')!;
  // 遮罩淡入、卡片 pop-in(带位移与缩放):等这两段开场动画放完再量。
  await Promise.all([backdrop, card].flatMap((el) => el.getAnimations()).map((animation) => animation.finished));
  expect(backdrop.getBoundingClientRect().top, 'backdrop starts at the title bar row bottom').toBe(row);
  expect(viewport.getBoundingClientRect().top, 'viewport starts at the title bar row bottom').toBe(row);
  expect(backdrop.getBoundingClientRect().bottom, 'backdrop still reaches the window bottom').toBe(innerHeight);
  expect(card.getBoundingClientRect().top, 'card stays inside its layer').toBeGreaterThanOrEqual(row);

  if (platform === 'win') {
    const bar = document.querySelector<HTMLElement>('.gg-titlebar')!;
    for (const x of [innerWidth * 0.3, innerWidth * 0.5, innerWidth * 0.7]) {
      expect(hitInside(x, row / 2, bar), `title bar row is topmost at x=${Math.round(x)}`).toBe(true);
    }
    const close = document.querySelector<HTMLElement>('.gg-winctl--close')!;
    const r = close.getBoundingClientRect();
    expect(hitInside(r.left + r.width / 2, r.top + r.height / 2, close), 'window close stays reachable').toBe(true);
  }
});
