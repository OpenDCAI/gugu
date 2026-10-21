import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { contact, createNode, createReactHarness, deferred, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import '@/i18n/registerContactsCatalog';
import '@/styles/tokens.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/agentShare', async (original) => ({ ...(await original<object>()), shareAgentWithFriends: vi.fn() }));

const { GroupInviteCard } = await import('@/components/groups/GroupInviteCard');
const { GroupInviteQrShare, GroupJoinConfirmDialog, GroupInviteJoinModal } = await import('@/components/contacts/GroupInvite');
const { ShareAgentModal } = await import('@/components/contacts/ShareAgentModal');
const { shareAgentWithFriends } = await import('@/lib/agentShare');
const { chatService } = await import('@/lib/chat');
const { contactsService } = await import('@/lib/contacts');
type ShareOutcomes = Awaited<ReturnType<typeof shareAgentWithFriends>>;
const group = { id: 'group-7333', name: '设计讨论', public_id: 7333, member_count: 3, is_member: false, join_mode: 'approval', join_request_status: null } as const;
let harness: ReturnType<typeof createReactHarness>;
const tier = (element: Element) => {
  const style = getComputedStyle(element);
  return [Number.parseFloat(style.fontSize), Number.parseFloat(style.lineHeight)];
};
const textElement = (root: ParentNode, text: string) => {
  const element = [...root.querySelectorAll<HTMLElement>('div, span, button')].findLast((item) => item.textContent === text);
  if (!element) throw new Error(`Missing rendered text: ${text}`);
  return element;
};
const t = (key: string, options = {}) => i18n.t(key, { ns: 'contacts', ...options });
async function render(node: Parameters<typeof renderWithAppProviders>[1]) {
  harness = createReactHarness();
  harness.container.style.width = '380px';
  await renderWithAppProviders(harness, node);
}
beforeEach(async () => {
  await page.viewport(1000, 720);
  await i18n.changeLanguage('zh-CN');
  document.documentElement.dataset.theme = 'light';
  vi.mocked(shareAgentWithFriends).mockReset();
  expect(t('common.cancel')).not.toBe('common.cancel');
});
afterEach(() => {
  harness?.cleanup();
  delete document.documentElement.dataset.theme;
});

describe('share and invite surfaces use the approved roles without changing actions (#7333)', () => {
  it.each(['light', 'dark'])('the %s invite card keeps approval action and uses shared disabled feedback', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const onJoin = vi.fn();
    await render(createNode(GroupInviteCard, { group, onJoin }));
    const card = harness.container.querySelector<HTMLElement>('[data-state="joinable"]')!;
    expect(getComputedStyle(card).borderRadius).toBe('12px');
    expect(tier(textElement(card, group.name))).toEqual([14, 20]);
    expect(tier(textElement(card, t('groupInvite.groupSummary', { number: 7333, count: 3 })))).toEqual([12, 18]);
    const action = page.getByRole('button', { name: t('groupInvite.actionLabel', { action: t('groupInvite.requestJoin'), group: group.name }), exact: true });
    await action.click();
    expect(onJoin).toHaveBeenCalledTimes(1);
    await renderWithAppProviders(harness, createNode(GroupInviteCard, { group, onJoin, joining: true }));
    const busy = harness.container.querySelector<HTMLButtonElement>('button')!;
    expect(busy.disabled).toBe(true);
    await until('the shared disabled opacity settled', () => getComputedStyle(busy).opacity === '0.58');
    await act(async () => busy.click());
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(busy.textContent).toBe(t('groupInvite.requesting'));
  });

  it('confirmation uses the real group and retains the one-confirm guard', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await render(createNode(GroupJoinConfirmDialog, { group, onConfirm, onCancel }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await until('the confirmation sheet finished entering', () => dialog.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    expect(tier(textElement(dialog, t('groupInvite.requestTitle')))).toEqual([16, 24]);
    expect(tier(textElement(dialog, t('groupInvite.groupNumberHash', { number: 7333 })))).toEqual([12, 18]);
    expect(tier(textElement(dialog, t('groupInvite.approvalHint')))).toEqual([14, 20]);
    const button = textElement(dialog, t('groupInvite.requestJoin')) as HTMLButtonElement;
    expect(button.getBoundingClientRect().height).toBe(32);
    await userEvent.click(button);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await page.getByRole('button', { name: t('common.cancel'), exact: true }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('membership, pending approval and missing link remain distinct non-joining states', async () => {
    const onJoin = vi.fn();
    let first = true;
    for (const [overrides, props, state, label] of [
      [{ is_member: true }, {}, 'joined', 'groupInvite.joined'],
      [{ join_request_status: 'pending' }, {}, 'pending', 'groupInvite.pendingApproval'],
      [{}, { joinTokenAvailable: false }, 'link_required', 'groupInvite.scanToJoin'],
    ] as const) {
      if (first) await render(createNode(GroupInviteCard, { group: { ...group, ...overrides }, ...props, onJoin, inactiveAction: 'button' }));
      else await renderWithAppProviders(harness, createNode(GroupInviteCard, { group: { ...group, ...overrides }, ...props, onJoin, inactiveAction: 'button' }));
      first = false;
      expect(harness.container.querySelector('[data-state]')?.getAttribute('data-state')).toBe(state);
      const button = harness.container.querySelector<HTMLButtonElement>('button')!;
      expect(button.textContent).toBe(t(label));
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('the QR section waits for the token, renders the actual QR, and copies the same link', async () => {
    const settings = deferred<Awaited<ReturnType<typeof chatService.getGroupChatSettings>>>();
    const getSettings = vi.spyOn(chatService, 'getGroupChatSettings').mockReturnValue(settings.promise);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await render(createNode(GroupInviteQrShare, { group: { id: group.id, kind: 'group', name: group.name, public_id: 7333, member_count: 3, avatar_url: null, is_muted: false } }));
    const copyQr = harness.container.querySelector<HTMLButtonElement>('[data-group-invite-qr-copy]')!;
    expect(copyQr.disabled).toBe(true);
    expect(copyQr.dataset.qrPayload).toBe('');
    await act(async () => settings.resolve({
      id: group.id, public_id: 7333, creator_user_id: 'user-1', name: group.name, status: 'active', group_prompt: null, default_agent_type: null,
      join_token: 'invite-fixture-token', description: null, max_members: 100, allow_member_invite: true, invite_link_enabled: true,
      agent_join_approval: false, join_mode: 'approval', hide_history: false, avatar_url: null, is_discoverable: false,
      agent_flood_threshold: null, agent_flood_threshold_effective: 5,
    }));
    await until('the actual QR image loaded', () => !!harness.container.querySelector<HTMLImageElement>('img')?.naturalWidth);
    expect(getSettings).toHaveBeenCalledWith(group.id);
    expect(copyQr.disabled).toBe(false);
    expect(copyQr.getBoundingClientRect().height).toBe(32);
    const image = harness.container.querySelector<HTMLImageElement>('img')!;
    expect(image.naturalWidth).toBe(132);
    expect(tier(textElement(harness.container, t('groupInvite.groupNumber', { number: 7333 })))).toEqual([12, 18]);
    const payload = copyQr.dataset.qrPayload!;
    expect(payload).toContain('gugu_qr=');
    await page.getByRole('button', { name: t('groupInvite.copyLink'), exact: true }).click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it('sharing keeps selection through search, disables submit while waiting, and retries only the failed friend', async () => {
    const alice = contact({ id: 'alice', display_name: '林知夏', email: 'alice@example.com' });
    const bob = contact({ id: 'bob', display_name: '陈小川', email: 'bob@example.com' });
    const agent = contact({ id: 'agent-7333', type: 'agent', display_name: '设计助手', email: null });
    const onClose = vi.fn();
    const outcomes = deferred<ShareOutcomes>();
    vi.mocked(shareAgentWithFriends).mockReturnValueOnce(outcomes.promise);
    await render(createNode(ShareAgentModal, { agent, contacts: [alice, bob], onClose }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await until('the sharing sheet finished entering', () => dialog.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    const invite = textElement(dialog, t('inviteAgent.invite')) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    expect(tier(textElement(dialog, t('inviteAgent.title', { name: agent.display_name })))).toEqual([16, 24]);
    expect(tier(textElement(dialog, alice.email!))).toEqual([12, 18]);
    await userEvent.click(dialog.querySelector('[data-share-contact="alice"]')!);
    await userEvent.click(dialog.querySelector('[data-share-contact="bob"]')!);
    const search = dialog.querySelector<HTMLInputElement>('input')!;
    await userEvent.fill(search, 'bob@example.com');
    expect(dialog.querySelectorAll('[data-share-contact]')).toHaveLength(1);
    expect(dialog.querySelector('[data-share-contact="bob"]')?.getAttribute('aria-pressed')).toBe('true');
    await userEvent.fill(search, '');
    expect(textElement(dialog, t('inviteAgent.selectedCount', { count: 2 }))).toBeTruthy();
    await userEvent.click(invite);
    await until('sharing is in flight', () => invite.disabled);
    expect(invite.textContent).toBe(t('inviteAgent.processing'));
    expect((dialog.querySelector(`[aria-label="${t('common.close')}"]`) as HTMLButtonElement).disabled).toBe(true);
    expect(shareAgentWithFriends).toHaveBeenCalledWith(agent.id, ['alice', 'bob'], expect.any(String));
    await act(async () => outcomes.resolve([
      { friendUserId: 'alice', status: 'pending' },
      { friendUserId: 'bob', status: 'failed', error: new Error('Network request failed') },
    ]));
    await until('only the failed friend remains selected', () => dialog.querySelectorAll('[data-share-contact][aria-pressed="true"]').length === 1 && !invite.disabled);
    expect(dialog.querySelector('[data-share-contact="bob"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(dialog.querySelector('[data-share-contact="alice"]')?.getAttribute('aria-pressed')).toBe('false');
    const error = [...dialog.querySelectorAll<HTMLElement>('div')].findLast((element) => element.textContent?.includes(t('inviteAgent.failedFor', { names: bob.display_name })))!;
    expect(tier(error)).toEqual([14, 20]);
    expect(onClose).not.toHaveBeenCalled();
    vi.mocked(shareAgentWithFriends).mockResolvedValueOnce([{ friendUserId: 'bob', status: 'pending' }]);
    await userEvent.click(invite);
    await until('the successful retry closes sharing', () => onClose.mock.calls.length === 1);
    expect(shareAgentWithFriends).toHaveBeenLastCalledWith(agent.id, ['bob'], expect.any(String));
  });

  it('the lookup dialog keeps loading and error visible and its shared close action usable', async () => {
    const lookup = deferred<Awaited<ReturnType<typeof contactsService.lookupPublicGroupInvite>>>();
    vi.spyOn(contactsService, 'lookupPublicGroupInvite').mockReturnValue(lookup.promise);
    const onClose = vi.fn();
    harness = createReactHarness();
    await renderWithAppProviders(harness, createNode(GroupInviteJoinModal, { publicId: 7333, joinToken: 'invite-fixture-token', onClose }), { chat: {} });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await until('the lookup sheet finished entering', () => dialog.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    expect(tier(textElement(dialog, t('groupInvite.joinTitle')))).toEqual([16, 24]);
    expect(tier(textElement(dialog, t('groupInvite.lookingUp')))).toEqual([14, 20]);
    await act(async () => lookup.resolve({ status: 'lookup_error', group: null }));
    expect(tier(textElement(dialog, t('groupInvite.lookupFailed')))).toEqual([14, 20]);
    const close = dialog.querySelector<HTMLButtonElement>(`[aria-label="${t('common.close')}"]`)!;
    expect(close.getBoundingClientRect().height).toBe(32);
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
