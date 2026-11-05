// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../support/testHarness';

vi.mock('@/platform', () => ({ platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } } }));
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, marketOffers: async () => ({ success: true, data: [] }), groupFileOpener: vi.fn(), setOpenWithDefault: vi.fn() },
}));
vi.mock('@/components/extensionBundle/sharedPackages', () => ({ sharedPackagesOf: async () => new Map(), subscribeSharedPackages: () => () => {} }));
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn(async () => ({ error: null })) } }));
vi.mock('@/lib/fileAccess', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/fileAccess')>(),
  fileMetadata: vi.fn(async () => ({ status: 'gone', sha256: null })),
}));
const { ask, chatTabs, shownItem } = await import('./chatTabsHarness');
const { installedExtensionsStore } = await import('@/session/renderer/features/extensions/installed-extensions-store');
const { GroupFileName } = await import('@/components/markdown/GroupFileName');
const { OpenWithPick } = await import('@/components/appSlot/OpenWithPick');
const workspace = { id: 'workspace', name: 'Folder', version: '1.0.0', apiVersion: 3, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Folder', opensFiles: { chat: ['.md', '.json'] } }] } };
const vote = { ...workspace, id: 'vote', contributes: { tabs: [{ name: 'main', title: 'Vote', opensFiles: { chat: ['.vote.json'] } }] } };
const candidate = { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: 'Folder', app: { name: 'Folder', defaultLocale: 'en' }, onlyTab: true, state: false, suffix: '.md' };
let harness: ReturnType<typeof createReactHarness>;
const originalCheckVisibility = HTMLElement.prototype.checkVisibility;
beforeEach(() => {
  harness = createReactHarness();
  HTMLElement.prototype.checkVisibility = () => false;
  act(() => installedExtensionsStore.applyList({ extensions: [workspace, vote], invalid: [] } as never));
});
afterEach(() => {
  harness.cleanup();
  HTMLElement.prototype.checkVisibility = originalCheckVisibility;
  act(() => installedExtensionsStore.applyList({ extensions: [], invalid: [] } as never));
});

describe('stored file names on message, tab, and chooser surfaces', () => {
  it.each([
    ['群公告.md', '群公告.md'], ['group-meta.json', 'group-meta.json'],
    ['todo.txt', 'todo.txt'], ['banner.png', 'banner.png'], ['x.vote.json', 'x'],
  ])('message file %s reads %s', async (name, expected) => {
    await harness.render(createElement(GroupFileName, { name }));
    expect(harness.container.textContent).toBe(expected);
  });

  it.each(['md', 'json'])('a claimed .%s file keeps its complete tab title', async suffix => {
    const chatId = `names-${suffix}`;
    const name = `report.${suffix}`;
    await harness.render(chatTabs({ chatId }));
    await act(async () => ask(chatId, { itemId: `file-${suffix}`, opener: {
      chatId, itemId: `file-${suffix}`, name, typedName: name,
      file: { document: false, contentType: suffix === 'md' ? 'text/markdown' : 'application/json', version: 1, size: 10 },
      choice: { kind: 'one', candidate: { ...candidate, suffix: `.${suffix}` } },
    } as never }));
    expect(shownItem(chatId)).toMatchObject({ kind: 'workspace.main', title: name });
  });

  it('the chooser heading keeps the generic file suffix', async () => {
    await harness.render(createElement(OpenWithPick, { detail: {
      chatId: 'names-chooser', itemId: 'file-md', name: 'report.md', typedName: 'report.md',
      file: { document: false, contentType: 'text/markdown', version: 1, size: 10 },
      choice: { kind: 'choose', suffix: '.md', candidates: [candidate] },
    }, onPick: vi.fn() }));
    expect(harness.container.querySelector('[data-testid="group-app-open-with"]')?.textContent).toContain('report.md');
  });
});
