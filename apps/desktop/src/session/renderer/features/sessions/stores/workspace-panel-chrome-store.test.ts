import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspacePanelChromeStoreForTests } from './workspace-panel-chrome-store';

const STORAGE_KEY = 'gugu.workspace-panel-chrome.v1';

describe('workspacePanelChromeStore', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('第一次默认收起;之后记得用户上一次的开合,重启也记得', () => {
    const first = createWorkspacePanelChromeStoreForTests();
    expect(first.collapsed).toBe(true);

    first.setCollapsed(false);
    expect(createWorkspacePanelChromeStoreForTests().collapsed).toBe(false);
  });

  // #7052 会话页没有面板了,也就没有全屏:旧版存下的全屏读回来不认,开合照旧。
  it('旧版存的全屏不认', () => {
    storage.set(STORAGE_KEY, JSON.stringify({ collapsed: false, maximizedSessionIds: ['session-a'] }));
    const upgraded = createWorkspacePanelChromeStoreForTests();
    expect(upgraded.collapsed).toBe(false);
    upgraded.setCollapsed(true);
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? '{}')).toEqual({ collapsed: true });
  });
});
