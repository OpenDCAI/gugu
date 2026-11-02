// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ nativeInputVersion: undefined as number | undefined, kind: 'project-error', reach: 'Lab Mac is offline' as string | null, link: 'closed', cloud: false }));
const fill = vi.hoisted(() => vi.fn());
vi.mock('./open-session-in-session', () => ({ openSessionInSessionWhenReady: fill }));
vi.mock('@renderer/lib/offline-session-slot', () => ({ OfflineSessionSlot: ({ sessionId }: { sessionId: string }) => <div data-offline-session={sessionId}>Shared timeline<textarea aria-label="Native message" /></div> }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => ({}), sessionViewKind: () => state.kind,
  getSessionManagerStore: () => ({}), sessionErrorMessage: () => 'Connection lost',
}));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'p', sessionId: 's' }), useWorkspaceViewModel: () => ({}),
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ ensureMounted: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => ({ label: 'Lab Mac' }), findListedSession: () => ({ nativeInputVersion: state.nativeInputVersion }) } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'mac-1' } }));
vi.mock('@renderer/lib/machine-clients', () => ({ machineLinkState: () => state.link }));
vi.mock('./workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => state.reach }));
vi.mock('./use-cloud-computer-gate', () => ({ useCloudComputerGate: () => state.cloud ? { label: 'Cloud', deviceId: 'mac-1', failure: null } : null }));
vi.mock('./session-tab-registry', () => ({ sessionTabView: {} }));
vi.mock('./view/session-main-column', () => ({ SessionMainColumn: () => null }));
vi.mock('@renderer/lib/ui/button', () => ({ Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }));
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: ({ label }: { label: string }) => <span>{label}</span> }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }));

import { SessionContentGate } from './main-panel';

let root: Root;
let container: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  state.nativeInputVersion = undefined; state.kind = 'project-error'; state.reach = 'Lab Mac is offline'; state.link = 'closed'; state.cloud = false; fill.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(() => root.render(<SessionContentGate><span>Task workspace</span></SessionContentGate>));

describe('task preparation while its machine is unavailable', () => {
  it.each(['project-error', 'provision-error'])('names the unavailable machine instead of a generic Retry screen: %s', kind => {
    state.kind = kind;
    render();
    expect(container.textContent).toBe('Lab Mac is offline');
    expect(container.querySelector('button')).toBeNull();
    state.reach = null; state.kind = 'ready'; state.link = 'open';
    render();
    expect(container.textContent).toBe('Task workspace');
  });

  it('still names the offline machine before the workspace reach resolver has a status', () => {
    state.reach = null;
    render();
    expect(container.textContent).toBe('Lab Mac is offline');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([1, 2])('uses the shared timeline before the native v%s workspace has mounted and fills once after recovery', version => {
    state.kind = 'project-error'; state.nativeInputVersion = version;
    render();
    expect(container.querySelector('[data-offline-session="s"]')).not.toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
    state.kind = 'ready'; state.reach = null; state.link = 'open';
    render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).toHaveBeenCalledExactlyOnceWith({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    render();
    expect(fill).toHaveBeenCalledOnce();
  });

  it.each(['project-mounting', 'idle', 'provisioning', 'project-error', 'provision-error', 'ready'])('keeps offline non-native tasks description-only: %s', kind => {
    state.kind = kind;
    render();
    expect(container.textContent).toBe('Lab Mac is offline');
    expect(container.querySelector('textarea, [data-offline-session]')).toBeNull();
  });

  it('keeps cloud wake ahead of the native offline page', () => {
    state.nativeInputVersion = 2; state.cloud = true;
    render();
    expect(container.textContent).toBe('remoteHost.status.waking');
    expect(container.querySelector('[data-offline-session]')).toBeNull();
  });

  it('does not fill an ordinary online task or a user-emptied layout', () => {
    state.nativeInputVersion = 2; state.kind = 'ready'; state.reach = null; state.link = 'open';
    render(); render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).not.toHaveBeenCalled();
  });

  it('keeps an ordinary failure actionable when the machine is connected', () => {
    state.reach = null; state.link = 'open';
    render();
    expect(container.textContent).toContain('task.setUpWorkspaceFailed');
    expect(container.querySelector('button')?.textContent).toBe('common.retry');
  });
});
