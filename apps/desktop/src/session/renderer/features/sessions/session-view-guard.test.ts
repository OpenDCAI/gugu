import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionViewCanActivate } from './session-view-guard';
import { NavigationStore } from '@renderer/lib/stores/navigation-store';

vi.mock('@renderer/lib/modal/modal-store', () => ({ modalStore: { closeModal: vi.fn() } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { push: vi.fn() }, sidebar: { revealActiveSession: vi.fn() } } }));

const state = vi.hoisted(() => ({ agentId: 'assistant', assistantId: 'assistant', archived: false }));
vi.mock('@/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: state.assistantId } }) }) }));
vi.mock('@renderer/features/sessions/stores/session-agent-names', () => ({ sessionAgentNames: { identityFor: () => state.agentId ? { agentUserId: state.agentId } : undefined } }));
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => 'present' }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => ({ sessions: new Map([['task', { data: { archivedAt: state.archived ? '2026-10-27' : null } }]]) }) }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ sessionLeaveDestination: () => ({ viewId: 'new-session' }) }));
beforeEach(() => { state.agentId = state.assistantId = 'assistant'; state.archived = false; });
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
