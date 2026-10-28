import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A page's `files.search` / `files.recent` on the desktop: the shared core is asked as whoever the page works as — the
 * agent its operator is (`page.asAgent`), or the person — never the person behind an agent's back.
 */

const search = vi.fn(async () => []);
const recent = vi.fn(async () => []);
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ list: () => ({ extensions: [] }), isEnabled: () => true }) }));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()), currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: { ensureFor: () => undefined }, fileServiceUrl: () => 'http://files.invalid', localFileService: {} }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@shared/extensions/app-files-core', async (original) => ({
  ...(await original<typeof import('@shared/extensions/app-files-core')>()),
  createAppFiles: () => ({ search, recent }),
}));

const { searchAppFiles, recentAppFiles } = await import('./app-files');
const AGENT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  search.mockClear();
  recent.mockClear();
});

describe('files.search / files.recent on the desktop: who asks', () => {
  it('a page an agent works: the agent', async () => {
    const page = { pageId: 1, extensionId: 'office', handed: null, asAgent: AGENT };
    await searchAppFiles(page, { query: 'q', suffixes: ['.MD'] });
    await recentAppFiles(page, { limit: 3 });
    expect(search).toHaveBeenCalledWith({ query: 'q', suffixes: ['.md'] }, { asAgent: AGENT });
    expect(recent).toHaveBeenCalledWith({ limit: 3 }, { asAgent: AGENT });
  });

  it('control: the person\'s page — no agent', async () => {
    const page = { pageId: 2, extensionId: 'office', handed: null };
    await searchAppFiles(page, undefined);
    await recentAppFiles(page, {});
    expect(search).toHaveBeenCalledWith({}, { asAgent: null });
    expect(recent).toHaveBeenCalledWith({}, { asAgent: null });
  });

  it('what is not a search is invalid before anything is asked', async () => {
    await expect(searchAppFiles({ pageId: 3, extensionId: 'office', handed: null }, { limit: 0 })).rejects.toMatchObject({ code: 'invalid' });
    expect(search).not.toHaveBeenCalled();
  });
});
