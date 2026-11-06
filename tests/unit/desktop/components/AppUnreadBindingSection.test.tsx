// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishSelfIdentity } from '../../../../apps/desktop/src/lib/selfIdentityBridge';
import { AppUnreadBindingSection, type UnreadBindingApi } from '../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-unread-binding-section';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));
// Avatar artwork is outside the authorization/selection behavior exercised here.
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }));
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const AUTHORITY = '44000000-0000-4000-8000-000000000004';
const choices = () => ({ success: true as const, data: { ownerId: OWNER, authority: AUTHORITY, selected: null, chats: [{ id: CHAT, name: 'Chosen conversation', kind: 'dm' as const }] } });
const api: UnreadBindingApi = { unreadBindingChoices: vi.fn(), setUnreadBinding: vi.fn() };
let root: Root;
let element: HTMLDivElement;
const render = async (extensionId = 'reader') => {
  await act(async () => root.render(<AppUnreadBindingSection extensionId={extensionId} name="main" api={api} translate={key => key} disabled={false} />));
};
const click = async (selector: string) => {
  const target = document.querySelector(selector);
  expect(target).not.toBeNull();
  await act(async () => target!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
beforeEach(async () => {
  vi.mocked(api.unreadBindingChoices).mockReset().mockResolvedValue(choices());
  vi.mocked(api.setUnreadBinding).mockReset().mockResolvedValue({ success: true });
  publishSelfIdentity({ userId: OWNER, displayName: 'Reader', guguNumber: null });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); publishSelfIdentity(null);
});

describe('host App unread permission selection', () => {
  it('reads choices only on request and saves only the explicitly confirmed conversation', async () => {
    expect(api.unreadBindingChoices).not.toHaveBeenCalled();
    await click('[data-testid="app-unread-binding-choose"]');
    expect(document.querySelector<HTMLButtonElement>('[data-testid="app-unread-binding-sheet-action"]')!.disabled).toBe(true);
    await click(`[data-pick-row="${CHAT}"]`);
    expect(api.setUnreadBinding).not.toHaveBeenCalled();
    await click('[data-testid="app-unread-binding-sheet-action"]');
    expect(api.setUnreadBinding).toHaveBeenCalledExactlyOnceWith({ extensionId: 'reader', name: 'main', ownerId: OWNER, authority: AUTHORITY, chatId: CHAT });
    expect(document.querySelector('[data-testid="app-unread-binding-sheet"]')).toBeNull();
  });

  it('cancels a selection without changing authority', async () => {
    await click('[data-testid="app-unread-binding-choose"]');
    await click(`[data-pick-row="${CHAT}"]`);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[data-testid="app-unread-binding-sheet"]')).toBeNull();
    expect(api.setUnreadBinding).not.toHaveBeenCalled();
  });

  it('discards a late choice response when the signed-in account changes', async () => {
    let resolve!: (value: ReturnType<typeof choices>) => void;
    vi.mocked(api.unreadBindingChoices).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await click('[data-testid="app-unread-binding-choose"]');
    await act(async () => publishSelfIdentity({ userId: OTHER, displayName: 'Other', guguNumber: null }));
    await act(async () => resolve(choices()));
    expect(document.querySelector('[data-testid="app-unread-binding-sheet"]')).toBeNull();
    expect(api.setUnreadBinding).not.toHaveBeenCalled();
  });

  it('discards choices from another App when the permission page changes during the read', async () => {
    let resolve!: (value: ReturnType<typeof choices>) => void;
    vi.mocked(api.unreadBindingChoices).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await click('[data-testid="app-unread-binding-choose"]');
    await render('different-app');
    await act(async () => resolve(choices()));
    expect(document.querySelector('[data-testid="app-unread-binding-sheet"]')).toBeNull();
    await click('[data-testid="app-unread-binding-choose"]');
    await click(`[data-pick-row="${CHAT}"]`);
    await click('[data-testid="app-unread-binding-sheet-action"]');
    expect(api.setUnreadBinding).toHaveBeenCalledExactlyOnceWith({ extensionId: 'different-app', name: 'main', ownerId: OWNER, authority: AUTHORITY, chatId: CHAT });
  });
});
