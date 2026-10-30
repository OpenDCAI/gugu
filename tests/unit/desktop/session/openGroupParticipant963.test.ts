import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';

const state = vi.hoisted(() => ({
  tabs: ['conversation', 'file', 'browser', 'app'], open: vi.fn(),
}));
const ready = observable.box(false);
vi.mock('@renderer/features/sessions/session-pane-ready', () => ({ sessionPaneReady: () => () => ready.get() }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionView: () => ({ paneLayout: { groups: [{ pane: { tabOrder: state.tabs } }], open: state.open } }),
  getSessionPageStore: () => undefined,
}));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => ({ sessions: { get: () => ({ data: { runtime: 'acp' } }) } }) },
}));
import { screenLayout } from '@renderer/app/screen-layout';
import { groupParticipantRequests } from '@renderer/features/chats/group-participant-requests';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import { openRequestedGroupParticipant } from '@renderer/features/chats/open-group-participant-session';

const source = { kind: 'chat', chatId: 'group-ready' } as const;
const target = { projectId: 'p', sessionId: 'a' };
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  runInAction(() => ready.set(false));
  groupParticipantPanes.hide(source.chatId);
  screenLayout.show(source);
  state.tabs = ['conversation', 'file', 'browser', 'app'];
});
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

describe('authorized focus notification to participant workspace', () => {
  it('waits for a workspace, then places it while retaining its original tabs', () => {
    groupParticipantRequests.prepare(source.chatId, target);
    const tabs = state.tabs;
    disposers.push(openRequestedGroupParticipant(target)!);
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source]);
    runInAction(() => ready.set(true));
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source, { kind: 'session', ...target }]);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.tabs).toBe(tabs);
    expect(state.tabs).toEqual(['conversation', 'file', 'browser', 'app']);
  });

  it('opens the conversation when the existing workspace has no tabs', () => {
    state.tabs = [];
    groupParticipantRequests.prepare(source.chatId, target);
    disposers.push(openRequestedGroupParticipant(target)!);
    runInAction(() => ready.set(true));
    expect(state.open).toHaveBeenCalledExactlyOnceWith('acp-chat', { sessionId: 'a' }, { preview: false });
    expect(screenLayout.sessions.map(one => one.sessionId)).toEqual(['a']);
  });

  it('does not let a delayed workspace replace the participant clicked afterward', () => {
    const later = { ...target, sessionId: 'b' };
    groupParticipantRequests.prepare(source.chatId, target);
    disposers.push(openRequestedGroupParticipant(target)!);
    groupParticipantRequests.prepare(source.chatId, later);
    disposers.push(openRequestedGroupParticipant(later)!);
    runInAction(() => ready.set(true));
    expect(screenLayout.sessions.map(one => one.sessionId)).toEqual(['b']);
  });

  it('consumes a cancelled group notification and leaves an independent entry alone', () => {
    groupParticipantRequests.prepare(source.chatId, target)();
    expect(openRequestedGroupParticipant(target)).toBeTypeOf('function');
    expect(openRequestedGroupParticipant(target)).toBeUndefined();
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source]);
  });
});
