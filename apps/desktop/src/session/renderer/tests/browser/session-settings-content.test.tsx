/**
 * 设置弹窗里由会话页画的那几格(product spec)是壳直接渲染的 —— 在会话页那棵树**外面**。
 * 它们用到的 context 由 SessionSettingsContent 补齐;少补一样,那一格一打开就渲染失败,整个壳落进错误页
 * (2026-10-02 mac1 实测:「界面」的工具列表那时还要会话页的主题 context,没补时整屏「This screen ran into an error」)。
 * 这里逐格在一棵只有 SessionSettingsContent 的树里渲染,钉住「每一格都画得出来」。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import {
  SessionSettingsContent,
  type SessionSettingsSection,
} from '@renderer/features/settings/components/SettingsPage';
import '@/styles/tokens.css';
import '@renderer/index.css';

// This suite checks settings-shell composition without either a host or a cloud account.
// Subscription details have their own connected-data suite; no Supabase client is constructed here.
vi.mock('@/lib/billing', () => ({
  getMembership: async () => null,
  useSpendingPower: () => ({ power: null, windows: null, balanceError: null, windowsError: null, activityRevision: 0 }),
  formatCredits: (value: number) => String(value),
  quotaWindowViews: vi.fn(),
  refreshSpendingPower: vi.fn(),
}));

// 测试里没有会话页宿主:宿主调用一律挂起不回(❌ 抛错 —— 抛错会落成测试之外的未处理错误)。
// 这一格只判「在会话页那棵树外面画得出来」,不判宿主给了什么。
vi.mock('@renderer/lib/ipc', async (importOriginal) => {
  const pending = () => new Promise(() => {});
  const namespace = new Proxy({}, { get: () => pending });
  return { ...(await importOriginal<object>()), rpc: new Proxy({}, { get: () => namespace }) };
});

let root: Root;
let host: HTMLDivElement;
let layer: HTMLDivElement;
const thrown: unknown[] = [];
const onError = (event: ErrorEvent) => thrown.push(event.error);

beforeEach(() => {
  host = document.createElement('div');
  layer = document.createElement('div');
  for (const el of [host, layer]) {
    el.className = 'gugu-skin emlight';
    document.body.append(el);
  }
  root = createRoot(host, { onUncaughtError: (error) => thrown.push(error) });
  thrown.length = 0;
  window.addEventListener('error', onError);
});

afterEach(() => {
  window.removeEventListener('error', onError);
  root.unmount();
  host.remove();
  layer.remove();
});

const SECTIONS: SessionSettingsSection[] = ['sessions', 'interface', 'repository', 'browser', 'subscriptions', 'resource-monitor'];

it.each(SECTIONS)('draws the 「%s」 section outside the task page tree', async (section) => {
  root.render(<SessionSettingsContent section={section} portalContainer={layer} />);
  // 判据:这一格提交了一次渲染且没有抛错。缺 context 时 React 卸掉整棵树:什么都不剩,thrown 里有那个错。
  // (不判「画出了一行」:有的页要等宿主回话才有行,测试环境里没有宿主。)
  await until(`the ${section} section renders`, () => thrown.length > 0 || host.childElementCount > 0);
  expect(thrown).toEqual([]);
  expect(host.childElementCount).toBeGreaterThan(0);
});
