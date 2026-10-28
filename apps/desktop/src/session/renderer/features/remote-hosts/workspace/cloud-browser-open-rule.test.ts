import { describe, expect, it } from 'vitest';
import type { CloudBrowserStatus } from '@shared/cloud-browser';
import { shouldOpenCloudBrowserTab } from './cloud-browser-open-rule';

const NOW = Date.parse('2026-10-28T06:00:00Z');

function status(patch: Partial<CloudBrowserStatus> = {}): CloudBrowserStatus {
  return {
    available: true,
    running: true,
    tabs: [{ tabId: 'T1', title: 'Example', url: 'https://example.com/', byAgent: true }],
    activeTabId: 'T1',
    automation: 'running',
    completed: false,
    controlled: false,
    lastActivityAt: '2026-10-28T05:59:00Z',
    live: { port: 1, token: 't' },
    ...patch,
  };
}

// #7199 server 上的 agent 开了浏览器:看着它的会话就把「浏览器」页签开出来(聊天页不再浮小窗,owner 10-28)。
describe('shouldOpenCloudBrowserTab', () => {
  it('agent 刚在用浏览器、这一次还没开过、页签也不在 = 开', () => {
    expect(shouldOpenCloudBrowserTab(status(), NOW, false, false)).toBe(true);
  });

  it('开过一次(人关掉了)或页签已经在 = 不再硬塞', () => {
    expect(shouldOpenCloudBrowserTab(status(), NOW, true, false)).toBe(false);
    expect(shouldOpenCloudBrowserTab(status(), NOW, false, true)).toBe(false);
  });

  it('没开 / 没页签 / 机器上没有 = 不开', () => {
    expect(shouldOpenCloudBrowserTab(null, NOW, false, false)).toBe(false);
    expect(shouldOpenCloudBrowserTab(status({ running: false }), NOW, false, false)).toBe(false);
    expect(shouldOpenCloudBrowserTab(status({ tabs: [] }), NOW, false, false)).toBe(false);
    expect(shouldOpenCloudBrowserTab(status({ available: false }), NOW, false, false)).toBe(false);
  });

  it('早就用完的浏览器 ❌ 一打开会话就弹;有人接管着 / 停着等放行照开', () => {
    const stale = { lastActivityAt: '2026-10-28T05:00:00Z' };
    expect(shouldOpenCloudBrowserTab(status(stale), NOW, false, false)).toBe(false);
    expect(shouldOpenCloudBrowserTab(status({ ...stale, controlled: true }), NOW, false, false)).toBe(true);
    expect(shouldOpenCloudBrowserTab(status({ ...stale, automation: 'stopped' }), NOW, false, false)).toBe(true);
  });
});
