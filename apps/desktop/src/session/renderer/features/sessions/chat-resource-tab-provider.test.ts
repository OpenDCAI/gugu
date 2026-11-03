import { makeAutoObservable, runInAction } from 'mobx';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ panel: vi.fn(), close: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/ownedAgentResources', () => ({ ownedAgentResourceTabs: () => ({ read: state.panel, close: state.close, open: state.open }), requestOwnedAgentResourceHost: vi.fn() }));
vi.mock('@/lib/icons', () => ({ Paperclip: () => null }));
vi.mock('../tabs/tab-bar/generic-tab-item', () => ({ GenericTabDragPreview: () => null, GenericTabItem: () => null }));
import { chatResourceTabProvider } from './chat-resource-tab-provider';
const entry = { kind: 'chat-resource', tabId: 'native-file', isPreview: false, state: { chatId: 'owned-dm', sourceTabId: 'authorized-file', item: { kind: 'workspace.main', itemId: 'file', title: 'receipt.html' } } };
beforeEach(() => vi.resetAllMocks());
it('retains the authorized file host and releases it when its native tab closes', () => {
  state.panel.mockReturnValue({ item: { title: 'receipt.html' } });
  const resource = chatResourceTabProvider.initialize(entry, { close: vi.fn() } as never, {} as never);
  expect(resource.title).toBe('receipt.html');
  expect(chatResourceTabProvider.isPersistent?.(entry.state)).toBe(true);
  expect(chatResourceTabProvider.isPersistent?.({ ...entry.state, item: { ...entry.state.item, kind: null } })).toBe(false);
  chatResourceTabProvider.onBeforeClose?.(entry, resource, {} as never, { alone: true });
  chatResourceTabProvider.dispose(entry, resource, {} as never);
  expect(state.close).toHaveBeenCalledExactlyOnceWith('owned-dm', 'authorized-file');
});
it('closes the native tab when the file page closes itself, without creating a chat destination', () => {
  const source = makeAutoObservable({ exists: true });
  state.panel.mockImplementation(() => source.exists ? { item: { title: 'receipt.html' } } : null);
  const close = vi.fn();
  const resource = chatResourceTabProvider.initialize(entry, { close } as never, {} as never);
  runInAction(() => { source.exists = false; });
  expect(close).toHaveBeenCalledExactlyOnceWith({ force: true });
  resource.dispose();
});
it('restores a persistent App beside its original conversation without restoring an IM tab', () => {
  const restored = structuredClone(entry);
  state.panel.mockReturnValueOnce(null).mockReturnValue({ item: restored.state.item });
  state.open.mockReturnValue('restored-source');
  const resource = chatResourceTabProvider.initialize(restored, { close: vi.fn() } as never, {} as never);
  expect(state.open).toHaveBeenCalledExactlyOnceWith('owned-dm', restored.state.item);
  expect(restored.state.sourceTabId).toBe('restored-source');
  expect(resource.title).toBe('receipt.html');
  resource.dispose();
});
