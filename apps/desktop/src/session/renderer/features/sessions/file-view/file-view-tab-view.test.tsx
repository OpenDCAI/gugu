// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// owner 2026-10-05:「一个 html 浏览到一半,我切换下标签页再切回来就要重新加载,太影响体验了」。
const events = vi.hoisted(() => [] as string[]);

vi.mock('./workspace-file-view', () => ({
  WorkspaceFileView: ({ path }: { path: string }) => {
    useEffect(() => {
      events.push(`mount ${path}`);
      return () => { events.push(`unmount ${path}`); };
    }, [path]);
    return <div data-page={path} />;
  },
}));

import { TabContent } from './file-view-tab-view';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = { projectId: 'p', workspaceId: 'w', sessionId: 's', workspacePath: '/w' };
const tab = (path: string, active: string, kind = 'file-view') => ({ tabId: path, kind, isActive: path === active, resource: { path } });

let container: HTMLDivElement;
let root: Root;
const draw = (paths: string[], active: string) => act(() => root.render(
  <TabContent host={{ resolvedTabs: paths.map((path) => tab(path, active)), closeTab: vi.fn() } as never} ctx={ctx as never} />
));

beforeEach(() => {
  events.length = 0;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

it('keeps a page across a tab switch, loads no tab nobody looked at, and releases a closed one', () => {
  draw(['a.html', 'b.html', 'never.html'], 'a.html');
  const page = container.querySelector('[data-page="a.html"]');
  draw(['a.html', 'b.html', 'never.html'], 'b.html');
  draw(['a.html', 'b.html', 'never.html'], 'a.html');
  expect(container.querySelector('[data-page="a.html"]')).toBe(page);
  expect(events).toEqual(['mount a.html', 'mount b.html']);
  draw(['a.html', 'never.html'], 'a.html');
  expect(events.at(-1)).toBe('unmount b.html');
});

it('keeps it, hidden, while a tab of another kind is in front', () => {
  draw(['a.html'], 'a.html');
  draw(['a.html'], 'terminal');
  expect(events).toEqual(['mount a.html']);
  const layer = container.querySelector('[data-page="a.html"]')!.parentElement!;
  expect(layer.style.transform).toBe('scale(0)');
});
