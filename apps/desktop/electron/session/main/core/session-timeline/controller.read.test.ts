import { beforeEach, expect, it, vi } from 'vitest';
import { addNativeReplies, type NativeReadJournal } from '@gugu/session-core/session-record/native-read';

const state = vi.hoisted(() => ({ journal: {} as NativeReadJournal }));
vi.mock('./service', () => ({ nativeRecord: vi.fn(), nativeToolImage: vi.fn(), nativeAttachment: vi.fn() }));
vi.mock('./create-session', () => ({}));
vi.mock('./turn-files', () => ({ prefetchFiles: vi.fn() }));
vi.mock('./task-exchanges', () => ({ readTaskExchanges: vi.fn(), watchTaskExchanges: vi.fn(), unwatchTaskExchanges: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('../sessions/session-conversation-read', async () => {
  const { unreadNativeMessages, unreadOwnerNotifications, seeNativeReplies } = await import('@gugu/session-core/session-record/native-read');
  return {
    nativeConversationUnread: (id: string) => { expect(id).toBe('session'); return unreadNativeMessages(state.journal); },
    nativeOwnerNotificationUnread: (id: string) => { expect(id).toBe('session'); return unreadOwnerNotifications(state.journal); },
    markNativeConversationVisible: (_id: string, ids: string[]) => {
      state.journal = seeNativeReplies(state.journal, ids);
      return unreadNativeMessages(state.journal);
    },
  };
});
import { sessionTimelineController } from './controller';

beforeEach(() => { state.journal = addNativeReplies({}, ['ordinary', 'notice'], new Map(), new Set(['notice'])); });

it('returns owner-only identities alongside the ordinary journal through the actual RPC controller', () => {
  expect(sessionTimelineController.sessionReadState({ conversationId: 'session' })).toEqual({
    unreadKeys: ['ordinary', 'notice'], ownerNotificationUnreadKeys: ['notice'],
  });
});

it('confirms only that opening snapshot through the existing visible-read endpoint', () => {
  const opening = sessionTimelineController.sessionReadState({ conversationId: 'session' });
  state.journal = addNativeReplies(state.journal, ['later'], new Map(), new Set(['later']));
  sessionTimelineController.sessionVisible({ conversationId: 'session', itemIds: opening.ownerNotificationUnreadKeys });
  expect(sessionTimelineController.sessionReadState({ conversationId: 'session' })).toEqual({
    unreadKeys: ['ordinary', 'later'], ownerNotificationUnreadKeys: ['later'],
  });
});
