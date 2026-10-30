import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionViewCanActivate } from './session-view-guard';
import { NavigationStore } from '@renderer/lib/stores/navigation-store';

vi.mock('@renderer/lib/modal/modal-store', () => ({ modalStore: { closeModal: vi.fn() } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { push: vi.fn() }, sidebar: { revealActiveSession: vi.fn() } } }));

const state = vi.hoisted(() => ({ agentId: 'assistant', assistantId: 'assistant', archived: false, listed: true, listState: 'read' as 'reading' | 'read' | 'failed' }));
vi.mock('@/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: state.assistantId } }) }) }));
vi.mock('@renderer/features/sessions/stores/session-agent-names', () => ({ sessionAgentNames: { identityFor: () => state.agentId ? { agentUserId: state.agentId } : undefined } }));
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => 'present' }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => ({ listState: state.listState, sessions: state.listed ? new Map([['task', { data: { archivedAt: state.archived ? '2026-10-27' : null } }]]) : new Map() }) }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ sessionLeaveDestination: () => ({ viewId: 'new-session' }) }));
beforeEach(() => { state.agentId = state.assistantId = 'assistant'; state.archived = false; state.listed = true; state.listState = 'read'; });
describe('task destinations use the assistant identity, not the task title', () => {
  it('redirects the personal assistant task to the exact avatar destination, without overriding its remembered parameters', () => {
    expect(sessionViewCanActivate({ projectId: 'project', sessionId: 'task' })).toEqual({ ok: false, redirect: 'assistant' });
  });
  it('keeps an ordinary task on the task view', () => {
    state.agentId = 'ordinary-agent';
    expect(sessionViewCanActivate({ projectId: 'project', sessionId: 'task' })).toEqual({ ok: true });
  });
  it('restores an assistant task snapshot into the avatar destination while preserving the remembered assistant page', () => {
    const store = new NavigationStore();
    store.registerView('session');
    store.registerView('assistant');
    store.registerGuard('session', sessionViewCanActivate);
    const assistant = { tab: 'today' };
    store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId: 'project', sessionId: 'task' }, assistant } });
    expect(store.currentViewId).toBe('assistant');
    expect(store.viewParamsStore.assistant).toEqual(assistant);
    state.agentId = 'ordinary-agent';
    store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId: 'project', sessionId: 'task' } } });
    expect(store.currentViewId).toBe('session');
  });
  it('does not guess while the identity is unknown and retains the existing archive destination', () => {
    state.agentId = '';
    expect(sessionViewCanActivate({ projectId: 'project', sessionId: 'task' })).toEqual({ ok: true });
    state.archived = true;
    expect(sessionViewCanActivate({ projectId: 'project', sessionId: 'task' })).toEqual({ ok: false, redirect: 'new-session', params: undefined });
  });
});

describe('restoring a task while its project list is loading', () => {
  function restoreTask() {
    const store = new NavigationStore();
    store.registerView('session');
    store.registerView('new-session');
    store.registerGuard('session', sessionViewCanActivate);
    store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId: 'project', sessionId: 'task' } } });
    return store;
  }

  beforeEach(() => { state.agentId = 'ordinary-agent'; state.listed = false; state.listState = 'reading'; });

  it('keeps the saved destination through a temporarily empty list and its completed load', () => {
    const store = restoreTask();
    expect(store.currentViewId).toBe('session');
    state.listed = true;
    state.listState = 'read';
    store.revalidate();
    expect(store.currentViewId).toBe('session');
    expect(store.viewParamsStore.session).toEqual({ projectId: 'project', sessionId: 'task' });
  });

  it('redirects only when a completed list confirms the saved task is missing', () => {
    const store = restoreTask();
    expect(store.currentViewId).toBe('session');
    state.listState = 'read';
    store.revalidate();
    expect(store.currentViewId).toBe('new-session');
  });

  it('does not infer a deleted task from a failed list read', () => {
    state.listState = 'failed';
    expect(restoreTask().currentViewId).toBe('session');
  });
});
