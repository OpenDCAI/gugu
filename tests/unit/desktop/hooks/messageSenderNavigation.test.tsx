// @vitest-environment jsdom
import { act } from 'react';
import { createReactHarness } from '../../../support/testHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation';
import { openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks';

vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }));
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => harness.cleanup());
describe('message sender-name navigation', () => {
  it('hands a real peer to the same shell action as contact/profile chat', async () => {
    const sender = { id: 'peer', display_name: 'Cleo', avatar: null, bio: null, type: 'agent' as const };
    const openSender = vi.fn();
    function Navigation() { useLinkNavigation({ ownerId: 'owner', chats: [], contacts: [sender], openSender,
      openChat: vi.fn(), openFile: vi.fn(), openApp: vi.fn(), openProject: vi.fn(), openOwnApp: vi.fn(), openAssistant: vi.fn() }); return null; }
    await harness.render(<Navigation />);
    await act(async () => { await openLinkTarget({ kind: 'sender', userId: 'peer' }); });
    expect(openSender).toHaveBeenCalledWith(sender);
    await expect(openLinkTarget({ kind: 'sender', userId: 'unknown' })).rejects.toThrow();
    expect(openSender).toHaveBeenCalledTimes(1);
  });
  it('preserves the source group when opening a participant conversation', async () => {
    const sender = { id: 'peer', display_name: 'Cleo', avatar: null, bio: null, type: 'agent' as const };
    const openSender = vi.fn();
    function Navigation() { useLinkNavigation({ ownerId: 'owner', chats: [{ id: 'group-963', kind: 'group' } as import('@gugu/core/shared/types/chat').ChatItem], contacts: [sender], openSender,
      openChat: vi.fn(), openFile: vi.fn(), openApp: vi.fn(), openProject: vi.fn(), openOwnApp: vi.fn(), openAssistant: vi.fn() }); return null; }
    await harness.render(<Navigation />);
    await act(async () => { await openLinkTarget({ kind: 'sender', userId: sender.id, sourceChatId: 'group-963' }); });
    expect(openSender).toHaveBeenCalledExactlyOnceWith(sender, 'group-963');
  });

});
