import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ capabilities: new Set<string>(), read: vi.fn(async () => ({ size: 4, offset: 0, data: 'AA==' })), localRead: vi.fn(async () => ({ size: 4, offset: 0, data: 'AA==' })), machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null) }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: {}, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/local-files', () => ({ createLocalAppFiles: () => ({}) }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine }));
vi.mock('@main/core/extensions/working-copy-files', () => ({ readWorkingCopy: f.localRead }));
vi.mock('@shared/extensions/app-files-core', async original => ({ ...await original<object>(), createAppFiles: () => ({ read: f.read }) }));
const { readAppFile } = await import('./app-files');
const page = { pageId: 3, extensionId: 'reader', handed: null };
const item = '44444444-4444-4444-8444-444444444444';
const workspace = { workspace: 'session:11111111-1111-4111-8111-111111111111', id: 'data.bin' };
beforeEach(() => { f.capabilities.clear(); vi.clearAllMocks(); f.machine.mockResolvedValue(null); });
it('chat ranges reach the shared file gate with their pinned version and binding', async () => {
  await readAppFile({ ...page, handed: { id: item, chat: "group" } }, { ref: { id: item, version: 3 }, offset: 1, length: 2 });
  expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ itemId: item, pageId: 3 }), { ref: { id: item, version: 3 }, offset: 1, length: 2 });
});
it('a handed working copy still cannot read ranges without files:read', async () => {
  await expect(readAppFile({ ...page, handed: workspace }, { ref: workspace, offset: 0, length: 1 })).rejects.toMatchObject({ code: 'denied' });
  expect(f.localRead).not.toHaveBeenCalled(); expect(f.machine).not.toHaveBeenCalled();
});
it('files:read admits a local working copy and preserves the remote all-machines gate', async () => {
  f.capabilities.add('files:read');
  await expect(readAppFile(page, { ref: workspace, offset: 0, length: 1 })).resolves.toMatchObject({ size: 4 });
  expect(f.localRead).toHaveBeenCalledTimes(1);
  f.machine.mockResolvedValue({ deviceId: 'remote', projectId: null });
  await expect(readAppFile(page, { ref: workspace, offset: 0, length: 1 })).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('files:read:all-machines') });
  expect(f.localRead).toHaveBeenCalledTimes(1);
});
