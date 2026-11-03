import { beforeEach, expect, it, vi } from 'vitest';
import { callRefusal } from '@shared/extensions/bridge-protocol';

const f = vi.hoisted(() => ({ capabilities: new Set<string>(), read: vi.fn(async () => ({ size: 4, offset: 0, data: new Uint8Array([0]) })), localRead: vi.fn(async () => ({ size: 4, offset: 0, data: 'AA==' })), machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null), remoteRead: vi.fn(async () => ({ there: true as const, value: { size: 4, offset: 0, data: 'AP+A' } })) }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap), get: () => ({ manifest: { id: 'reader' } }) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: {}, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/local-files', () => ({ createLocalAppFiles: () => ({}) }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine, callOnSessionMachine: f.remoteRead }));
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
it('the shared bridge requires files:read even for a handed working copy', async () => {
  expect(callRefusal('filesRead', { ref: workspace, offset: 0, length: 1 }, { kind: 'page', has: cap => f.capabilities.has(cap), gesture: false, widget: false })).toMatchObject({ code: 'denied' });
  expect(f.localRead).not.toHaveBeenCalled(); expect(f.machine).not.toHaveBeenCalled();
  f.capabilities.add('files:read');
  expect(callRefusal('filesRead', { ref: workspace }, { kind: 'page', has: cap => f.capabilities.has(cap), gesture: false, widget: false })).toBe(null);
});
it('files:read admits a local working copy and preserves the remote all-machines gate', async () => {
  f.capabilities.add('files:read');
  await expect(readAppFile(page, { ref: workspace, offset: 0, length: 1 })).resolves.toMatchObject({ size: 4, data: new Uint8Array([0]) });
  expect(f.localRead).toHaveBeenCalledTimes(1);
  f.machine.mockResolvedValue({ deviceId: 'remote', projectId: null });
  await expect(readAppFile(page, { ref: workspace, offset: 0, length: 1 })).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('files:read:all-machines') });
  expect(f.localRead).toHaveBeenCalledTimes(1);
});
it('decodes the existing remote workspace wire only at the App reply boundary', async () => {
  f.capabilities.add('files:read'); f.capabilities.add('files:read:all-machines');
  f.machine.mockResolvedValue({ deviceId: 'remote', projectId: null });
  const answer = await readAppFile(page, { ref: workspace, offset: 0, length: 3 });
  expect(answer.data).toBeInstanceOf(Uint8Array);
  expect([...answer.data]).toEqual([0, 255, 128]);
  expect(answer.data.buffer.byteLength).toBe(3);
  expect(f.remoteRead).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'filesRead', { ref: workspace, offset: 0, length: 3 }, false);
  expect(f.localRead).not.toHaveBeenCalled();
});
