// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ reload: vi.fn(), showError: vi.fn() }));
vi.mock('@renderer/features/sessions/request-session-reload', () => ({ requestSessionReload: h.reload }));
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({ requestArchiveSession: vi.fn() }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => ({ sessions: new Map([['task', { data: {} }]]) }) },
}));
vi.mock('@renderer/lib/electron-api', () => ({ findSessionHostBridge: () => null }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => h.showError }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('../session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'project', sessionId: 'task' }),
}));
vi.mock('@/components/legacy-dm-history/LegacyDmHistoryEntry', () => ({ LegacyDmHistoryDialog: () => null }));
vi.mock('@/components/legacy-dm-history/useLegacyDmHistoryEntry', () => ({
  useLegacyDmHistoryEntry: () => ({ isAvailable: () => false, onMenuOpen: () => undefined }),
}));
vi.mock('@renderer/features/sessions/session-reload-confirm', () => ({
  SessionReloadConfirm: ({ open, onConfirm }: { open: boolean; onConfirm: () => Promise<void> }) =>
    open ? <button data-confirm onClick={() => void onConfirm()}>confirm</button> : null,
}));

import { SessionActionsProvider, useSessionTabCommands } from './session-actions';

function TaskMenu() {
  const reload = useSessionTabCommands('task', () => undefined).find(command => command.id === 'session:reload');
  return <button data-reload disabled={reload?.isAvailable?.() === false} onClick={() => reload?.run()}>reload</button>;
}

let root: Root;
let container: HTMLDivElement;
function mount() {
  h.reload.mockReset();
  h.showError.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<SessionActionsProvider><TaskMenu /></SessionActionsProvider>));
}
function click(selector: string) {
  act(() => (container.querySelector(selector) as HTMLButtonElement).click());
}
afterEach(() => act(() => root?.unmount()));

describe('manual reload acceptance', () => {
  it('closes confirmation while the host is pending, blocks another restart, then restores the action', async () => {
    mount();
    let finish!: (value: { ok: true }) => void;
    h.reload.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    click('[data-reload]');
    expect(container.querySelector('[data-confirm]')).not.toBeNull();
    click('[data-confirm]');
    expect(container.querySelector('[data-confirm]')).toBeNull();
    expect((container.querySelector('[data-reload]') as HTMLButtonElement).disabled).toBe(true);
    click('[data-reload]');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledWith({ sessionId: 'task', reason: 'manual' });
    await act(async () => finish({ ok: true }));
    expect((container.querySelector('[data-reload]') as HTMLButtonElement).disabled).toBe(false);
    expect(h.showError).not.toHaveBeenCalled();
  });

  it('keeps the existing error message after the accepted confirmation has closed', async () => {
    mount();
    let finish!: (value: { ok: false; error: string }) => void;
    h.reload.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    click('[data-reload]');
    click('[data-confirm]');
    expect(container.querySelector('[data-confirm]')).toBeNull();
    await act(async () => finish({ ok: false, error: 'Provider session cannot be restored' }));
    expect(h.showError).toHaveBeenCalledWith(expect.objectContaining({ description: 'Provider session cannot be restored' }));
    expect((container.querySelector('[data-reload]') as HTMLButtonElement).disabled).toBe(false);
  });
});
