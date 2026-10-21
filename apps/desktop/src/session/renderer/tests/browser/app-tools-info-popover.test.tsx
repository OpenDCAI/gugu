/**
 * App 页「给 agent 的工具」那一行的 ⓘ(owner 10-14):开关叫「常驻 agent 的工具列表」,「关着也能用」那句在旁边的 ⓘ 里,
 * 悬停能看、点一下也能打开(手机没有悬停)。设置页、Agent 设置里的 ⓘ 是同一个组件(lib/ui/info-tooltip.tsx)。
 *
 * **为什么必须真 Chromium**:真指针是 pointerdown → pointerup → click,还有悬停、键盘焦点;jsdom 的 `.click()` 只发
 * click。评审(2026-10-14)量到:同一处改动在 jsdom 里全绿,
 * 在真浏览器里「悬停打开后点一下反而收起」。开关的无障碍名字也只有真浏览器算得出来(getByRole 按 accname)。
 *
 * 渲染的是真的 AppProductPage,只挡掉 IPC 和「给哪些 agent」那一节。
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';

// Every export the page's modules import (a browser's ES modules refuse a missing name); none is called here.
vi.mock('@renderer/lib/ipc', () => {
  const rpc = { extensions: {} };
  return {
    rpc,
    rpcOn: () => rpc,
    invokeOnMachine: async () => undefined,
    eventSourceMachine: () => null,
    events: { on: () => () => {} },
    onMachineEvent: () => () => {},
  };
});
vi.mock('@renderer/features/extensions/panel/app-given-section', () => ({ AppGivenSection: () => null }));

const { AppProductPage } = await import('@renderer/features/extensions/panel/app-product-page');
const { InfoTooltip } = await import('@renderer/lib/ui/info-tooltip');
const { UiPortalContainerProvider } = await import('@gugu/session-ui/react/primitives');
await import('@renderer/index.css');

// Keys stay readable on the page: the switch's words, the ⓘ's words, the ⓘ's own name.
const translate = ((key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;
const WORDS = 'extensions.fullDisclosureToggle';
const INFO = 'extensions.fullDisclosureInfo';
const INFO_LABEL = 'extensions.fullDisclosureInfoLabel';

const app = {
  id: 'pomodoro-log',
  name: 'Pomodoro',
  version: '1.2.0',
  apiVersion: EXTENSION_API_VERSION,
  permissions: { capabilities: ['agents:tools'] },
  contributes: { tabs: [], mcpServers: [{ name: 'pomodoro', command: 'node', args: ['mcp/server.mjs'] }] },
} as never;

const changes: string[] = [];

function Page() {
  const [disclosure, setDisclosure] = useState<'full' | 'progressive'>('progressive');
  const props = {
    subject: { manifest: app, installed: app, installRef: undefined, cloud: null },
    enabled: true,
    lifecycle: null,
    locale: 'en',
    translate,
    api: {
      marketReadme: async () => ({ success: true, data: { readme: null } }),
      marketHistory: async () => ({ success: true, data: [] }),
    },
    onBack: () => undefined,
    onLifecycle: () => undefined,
    onInstallVersion: () => undefined,
    menu: {},
    disclosure,
    onDisclosureChange: (next: 'full' | 'progressive') => {
      changes.push(next);
      setDisclosure(next);
    },
  } as unknown as Parameters<typeof AppProductPage>[0];
  return (
    <>
      <AppProductPage {...props} />
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
    </>
  );
}

/** Open = its popup is there and says so (a closing one can stay mounted for its exit animation). */
const shown = () =>
  [...document.querySelectorAll('[data-slot="popover-content"]')].some(
    (popup) => popup.hasAttribute('data-open') && (popup.textContent ?? '').includes(INFO)
  );
const info = () => page.getByRole('button', { name: INFO_LABEL, exact: true });
const elsewhere = () => page.getByTestId('elsewhere');

/**
 * The ⓘ's delays are the product's timing, so time is an input here, ❌ a stretch of wall clock (#4357; as
 * sidebar-row-actions-hover-5818). Every one of them is a Base UI `Timeout`, i.e. setTimeout: the 150 ms rest before a
 * hover opens it, the close delay, safePolygon's 40 ms, the 500 ms in which a click pins a hover-opened popup. Only
 * setTimeout / clearTimeout are faked; `until` keeps the real clock it took at load.
 */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
/** Time moves on by `ms` (by default: past every timer now waiting); React has drawn what they did. */
const timePasses = (ms?: number) =>
  act(async () => {
    if (ms === undefined) vi.runOnlyPendingTimers();
    else vi.advanceTimersByTime(ms);
  });

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  changes.length = 0;
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.width = '720px';
  host.style.padding = '80px 24px';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Page />);
  await expect.element(info()).toBeInTheDocument();
});

afterEach(() => {
  // A case that failed on the fake clock must not leave it to the next one.
  vi.useRealTimers();
  root.unmount();
  host.remove();
});

describe('App 页工具开关旁的 ⓘ(真 Chromium)', () => {
  // A hover-opened popup is pinned by a click only within Base UI's first 500 ms (PATIENT_CLICK_THRESHOLD); a later click
  // closes it — accepted (148 10-14): seen while hovering, a click after reading puts it away. With the clock faked,
  // "a click at once" and "a click after reading" are on their side of that line by construction.
  it('不悬停直接点一下:打开并钉住,鼠标移开也还在', async () => {
    fakeTimers();
    // The hover delay cannot run out on this clock: it is the click that opens it.
    await userEvent.click(info());
    await until('ⓘ 打开', shown);
    await userEvent.hover(elsewhere());
    await timePasses();
    expect(shown(), '点开的,鼠标移开、延时都过了也还在').toBe(true);
  });

  it('悬停打开,看了一会儿再点:收起', async () => {
    fakeTimers();
    await userEvent.hover(info());
    await timePasses(149);
    expect(shown(), '停了 149 ms:还没到 150 ms 的延时').toBe(false);
    await timePasses(1);
    await until('悬停满 150 ms 打开', shown);
    // Past the 500 ms in which a click would pin it.
    await timePasses();
    await userEvent.click(info());
    await until('再点一下收起', () => !shown());
  });

  it('点一下打开;Escape 关上,之后不会又被悬停打开', async () => {
    fakeTimers();
    await userEvent.click(info());
    await until('ⓘ 打开', shown);
    await userEvent.keyboard('{Escape}');
    await until('Escape 收起', () => !shown());
    // The pointer is still on the ⓘ, and moving there started its hover delay: that one, and every other, runs out.
    await timePasses();
    expect(shown(), 'Escape 之后,悬停的延时到了也不再打开').toBe(false);
  });

  it('点开以后点外面就关', async () => {
    await userEvent.click(info());
    await until('ⓘ 打开', shown);
    await userEvent.click(elsewhere());
    await until('点外面收起', () => !shown());
  });

  it('键盘:Enter 打开,Tab 走开就关', async () => {
    (info().element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await until('ⓘ 打开', shown);
    await userEvent.keyboard('{Tab}');
    await until('Tab 走开收起', () => !shown());
  });

  it('点开关的字拨开关、不开 ⓘ;点 ⓘ 不拨开关', async () => {
    fakeTimers();
    // Each click's own effect is the fact awaited; by then the one it must not have had would be there too (a <label>
    // passes its click on within the same event), and the timers have run out besides.
    await userEvent.click(page.getByText(WORDS, { exact: true }));
    await until('点字拨了开关', () => changes.join(), (v) => v === 'full');
    await timePasses();
    expect(shown(), '点字不开 ⓘ').toBe(false);
    await userEvent.hover(elsewhere());
    await userEvent.click(info());
    await until('ⓘ 打开', shown);
    await timePasses();
    expect(changes, '点 ⓘ 不拨开关').toEqual(['full']);
  });

  it('开关的无障碍名字只有那句文字,不带 ⓘ 的名字', async () => {
    expect(await page.getByRole('switch', { name: WORDS, exact: true }).all()).toHaveLength(1);
    expect(await page.getByRole('switch', { name: `${WORDS} ${INFO_LABEL}`, exact: true }).all()).toHaveLength(0);
  });
});

// 148 10-14: the Settings dialog mounts popups in a zero-size fixed layer (gg-session-settings-layer). A popup that is
// as wide as where it is mounted wrapped there after every word (82 px), while the same ⓘ was 278 px on the App page.
describe('ⓘ 挂在零尺寸的浮层落点里(设置弹窗就是这样)', () => {
  it('说明照常按字排开,最宽 320,不会一字一行', async () => {
    const layer = document.createElement('div');
    layer.className = 'gugu-skin emlight';
    Object.assign(layer.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '1' });
    document.body.appendChild(layer);
    try {
      root.render(
        <UiPortalContainerProvider value={layer}>
          <InfoTooltip label="settings-info" content="适用于 Claude Code 和 GitHub Copilot。启动前会写入信任记录。" />
        </UiPortalContainerProvider>
      );
      await userEvent.click(page.getByRole('button', { name: 'settings-info', exact: true }));
      await until('弹层打开', () => layer.querySelector('[data-slot="popover-content"][data-open]') !== null);
      const popup = layer.querySelector('[data-slot="popover-content"][data-open]') as HTMLElement;
      // Its layout width: the box on screen is still scaled by the opening animation (zoom-in-95 starts at 304).
      expect(popup.offsetWidth).toBe(320);
    } finally {
      root.render(<></>);
      layer.remove();
    }
  });
});
