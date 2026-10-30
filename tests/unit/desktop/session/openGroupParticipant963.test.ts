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
  it('leaves a normal focus alone after a group open fails before sending a notification', () => {
    const cancel = groupParticipantRequests.prepare(source.chatId, target);
    // The authorized host lookup failed; no group focus event will be emitted.
    cancel();
    // AppMenuEvents navigates normally only when this returns undefined.
    expect(openRequestedGroupParticipant(target)).toBeUndefined();
  });

  it('waits for a workspace, then places it while retaining its original tabs', () => {
    const request = groupParticipantRequests.prepare(source.chatId, target);
    const tabs = state.tabs;
    disposers.push(openRequestedGroupParticipant(target, request.requestId)!);
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source]);
    runInAction(() => ready.set(true));
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source, { kind: 'session', ...target }]);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.tabs).toBe(tabs);
    expect(state.tabs).toEqual(['conversation', 'file', 'browser', 'app']);
  });

  it('opens the conversation when the existing workspace has no tabs', () => {
    state.tabs = [];
    const request = groupParticipantRequests.prepare(source.chatId, target);
    disposers.push(openRequestedGroupParticipant(target, request.requestId)!);
    runInAction(() => ready.set(true));
    expect(state.open).toHaveBeenCalledExactlyOnceWith('acp-chat', { sessionId: 'a' }, { preview: false });
    expect(screenLayout.sessions.map(one => one.sessionId)).toEqual(['a']);
  });

  it('does not let a delayed workspace replace the participant clicked afterward', () => {
    const later = { ...target, sessionId: 'b' };
    const first = groupParticipantRequests.prepare(source.chatId, target);
    disposers.push(openRequestedGroupParticipant(target, first.requestId)!);
    const second = groupParticipantRequests.prepare(source.chatId, later);
    disposers.push(openRequestedGroupParticipant(later, second.requestId)!);
    runInAction(() => ready.set(true));
    expect(screenLayout.sessions.map(one => one.sessionId)).toEqual(['b']);
  });

  it('consumes a cancelled group notification and leaves an independent entry alone', () => {
    const request = groupParticipantRequests.prepare(source.chatId, target);
    request();
    expect(openRequestedGroupParticipant(target, request.requestId)).toBeTypeOf('function');
    expect(openRequestedGroupParticipant(target)).toBeUndefined();
    expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source]);
  });

  it('keeps an old same-session receipt from taking a newer group placement', () => {
    const first = groupParticipantRequests.prepare(source.chatId, target);
    first();
    const second = groupParticipantRequests.prepare(source.chatId, target);
    disposers.push(openRequestedGroupParticipant(target, first.requestId)!);
    runInAction(() => ready.set(true));
    expect(screenLayout.sessions).toHaveLength(0);
    disposers.push(openRequestedGroupParticipant(target, second.requestId)!);
    expect(screenLayout.sessions.map(one => one.sessionId)).toEqual(['a']);
  });
});
