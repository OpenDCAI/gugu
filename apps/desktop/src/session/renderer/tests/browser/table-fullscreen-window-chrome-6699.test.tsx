/**
 * #6699 表格「全屏」浮层不能钻到窗口 chrome 底下。
 *
 * Streamdown 的表格全屏自己 `createPortal` 到 body(`fixed inset-0 z-50`),不经咕咕的浮层原语。
 * 修之前:它从窗口顶沿铺起、又低于 Windows 标题栏行,「复制 / 下载 / ×」整排钻进标题栏底下,× 正压在窗口
 * 关闭钮下面,只剩 Esc 能退;tokens.css 那条当时不分层的全局清零还把它的 p-4 抹成 0,那一排贴死窗口右上角。
 * owner 远程桌面按不出 Esc,整个应用卡住。
 *
 * 真 Chromium、真 CSS(tokens.css + 会话页 index.css)、真窗口 chrome(WindowControls —— Windows 画标题栏行,
 * Linux 画浮动三钮),平台属性与两个 token 照 main.tsx 的写法落。每一格判:
 *   · 浮层的 × 在自己中心点上是最上层(点得到);
 *   · Windows:窗口关闭钮在自己中心点上也仍是最上层,两者矩形不相交 —— 两个都点得到、点不错;
 *     Linux:浮层是模态,盖住浮动的三颗钮(与 Sheet 同一档);
 *   · 浮层从标题栏行下沿起铺;
 *   · 浮层整块退订窗口拖拽 —— mac / Linux 上那排钮落在会话页顶栏的拖拽带里,不退订就点不动(见 ui/Popover.tsx);
 *   · 浮层头部是它自己写的 p-4(16px),没被清零。
 * `other`(mac / 网页:不自绘 chrome)那一格只有后三条可判,前两条它天然成立 —— 它是 chrome 那两条的阴性对照。
 *
 * 渲染的是 Streamdown 本身(配置与 lib/ui/markdown-renderer.tsx 一致),不是 MarkdownRenderer:
 * 后者会把 mermaid / photoswipe / katex 一串依赖带进这个 project,每多一个都是 CI 冷缓存下半途预构建、
 * 整页重载的机会(见 vitest.config.ts 的 optimizeDeps 说明)。被测的是浮层与咕咕 CSS 的约定,不是那层包装。
 */
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { WindowControls } from '@/components/WindowControls';
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

const TABLE = '| # | 是什么 | 代价 |\n| --- | --- | --- |\n| 1 | 扩展读写黑名单 | 小 |\n| 2 | 渲染进程崩溃接管 | 小 |';

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function mount(className: string, node: ReactNode, style = ''): void {
  const host = document.createElement('div');
  host.className = className;
  host.style.cssText = style;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(node);
  roots.push(root);
  hosts.push(host);
}

/** main.tsx 开机时落的那几样(平台属性 + 两个几何 token),同一套函数算。 */
function applyPlatform(platform: RendererPlatform): void {
  const html = document.documentElement;
  html.dataset.platform = platform;
  if (platform === 'win') html.dataset.windowTitlebar = 'row';
  else delete html.dataset.windowTitlebar;
  html.style.setProperty('--titlebar-controls-width', `${windowControlsWidth(platform)}px`);
  html.style.setProperty('--window-titlebar-height', `${windowTitlebarHeight(platform)}px`);
}

function topmostAtCentre(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit !== null && el.contains(hit);
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

beforeEach(async () => {
  await page.viewport(1100, 700);
  // 窗口桥(preload 的 desktopWindow):WindowControls 只在它存在时才画 chrome。
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
  for (const root of roots.splice(0)) root.unmount();
  for (const host of hosts.splice(0)) host.remove();
  const html = document.documentElement;
  delete html.dataset.platform;
  delete html.dataset.windowTitlebar;
  html.style.removeProperty('--titlebar-controls-width');
  html.style.removeProperty('--window-titlebar-height');
  Reflect.deleteProperty(window, 'desktopWindow');
});

it.each(['win', 'linux', 'other'] as const)('%s: the table fullscreen overlay keeps its own exit reachable beside the window chrome', async (platform) => {
  applyPlatform(platform);
  // 会话页的正文在挂载元素里(带 .gugu-skin);窗口 chrome 在壳里(不带)。浮层 portal 到 body —— 两边都不在,与产品一致。
  // 正文落在内容区里(窗口 chrome 之下),与产品里文件预览的位置同一类 —— 不然表格自己那排按钮就先被 chrome 压住了。
  mount('emlight gugu-skin', (
    <Streamdown mode="static" parseIncompleteMarkdown={false} controls={{ code: { download: false } }} linkSafety={{ enabled: false }}>
      {TABLE}
    </Streamdown>
  ), 'position: absolute; top: 120px; left: 80px; width: 720px;');
  mount('', (
    <WindowControls
      activeTab="tasks"
      mobile={false}
      activeChatId={null}
      chats={[]}
      sessionHostAvailable
      onSelectTab={() => undefined}
      onOpenChat={() => undefined}
      onNewAgent={() => undefined}
      onOpenSettings={() => undefined}
    />
  ));

  await page.getByTitle('View fullscreen').click();
  const overlay = document.querySelector<HTMLElement>('[data-streamdown="table-fullscreen"]');
  expect(overlay, 'fullscreen overlay mounted').toBeTruthy();
  const exit = overlay!.querySelector<HTMLElement>('button[title="Exit fullscreen"]');
  expect(exit, 'overlay exit button rendered').toBeTruthy();
  const windowClose = document.querySelector<HTMLElement>('.gg-winctl--close');
  expect(Boolean(windowClose), 'window close button drawn only where the app draws chrome').toBe(platform !== 'other');

  expect(overlay!.getBoundingClientRect().top, 'overlay starts at the title bar row bottom').toBe(windowTitlebarHeight(platform));
  expect(getComputedStyle(overlay!).getPropertyValue('-webkit-app-region'), 'overlay opts out of window dragging').toBe('no-drag');
  expect(getComputedStyle(exit!.parentElement!).paddingTop, 'overlay header keeps its own p-4').toBe('16px');
  expect(topmostAtCentre(exit!), 'overlay exit is hit-testable').toBe(true);
  if (platform === 'win') {
    expect(topmostAtCentre(windowClose!), 'window close stays hit-testable').toBe(true);
    expect(intersects(exit!.getBoundingClientRect(), windowClose!.getBoundingClientRect()), 'overlay exit and window close overlap').toBe(false);
  }
});
