// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';
import { readProjectGroupChats, readProjectGroupMembers } from '@/lib/projectGroupChatsBridge';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { groupInviteAccess } from '@/lib/groupMemberPermissions';
import { ProjectGroupsStore, projectGroupsStore } from './project-groups-store';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {},
  onMachineEvent: () => () => {},
  rpcOn: () => ({ projects: { listProjectGroupBindings: async () => ({ success: true, data: [] }) } }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({ AcpChatStore: class {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({ AcpChatPanel: () => null }));

type ProjectManager = ConstructorParameters<typeof SidebarStore>[0];
const project = (id: string, kind?: string) => ({
  id, name: id, createdAt: '2026-01-01T00:00:00.000Z', data: { kind }, mountedProject: null,
});

describe('project group visibility across Projects and Chats', () => {
  it('only hides groups with a project row, including when rows arrive or disappear after bindings', async () => {
    const projects = observable.map([
      ['visible-project', project('visible-project')],
      ['workspace-project', project('workspace-project', 'workspace')],
    ]);
    const groups = new ProjectGroupsStore();
    const sidebar = new SidebarStore({ projects } as unknown as ProjectManager);
    sidebar.machines = { machineOf: () => null, label: () => null, homeDir: () => null, projectGroupOf: (id) => groups.chatIdOf(id) };
    groups.start(() => [], () => [], () => sidebar.sidebarProjects.map(({ id }) => id));
    await vi.waitFor(() => expect(groups.bindingKnown('visible-project')).toBe(true));
    groups.applyBindings(null, [
      { projectId: 'visible-project', chatId: 'visible-group' },
      { projectId: 'hidden-project', chatId: 'hidden-group' },
      { projectId: 'workspace-project', chatId: 'workspace-group' },
    ]);

    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['visible-project']);
    expect([...readProjectGroupChats()]).toEqual(['visible-group']);
    expect(groups.chatIdOf('hidden-project')).toBe('hidden-group');
    expect(groups.projectOfChat('hidden-group')).toBe('hidden-project');
    expect(groups.rowProjectOfChat('visible-group')).toBe('visible-project');
    expect(groups.rowProjectOfChat('hidden-group')).toBeUndefined();
    expect(groups.rowProjectOfChat('workspace-group')).toBeUndefined();

    runInAction(() => projects.set('hidden-project', project('hidden-project')));
    expect(new Set(readProjectGroupChats())).toEqual(new Set(['visible-group', 'hidden-group']));
    expect(groups.rowProjectOfChat('hidden-group')).toBe('hidden-project');
    runInAction(() => projects.delete('hidden-project'));
    expect([...readProjectGroupChats()]).toEqual(['visible-group']);
    expect(groups.rowProjectOfChat('hidden-group')).toBeUndefined();
  });

  it('keeps one project group when its representative row changes and preserves hidden-project members', async () => {
    const projects = observable.map([
      ['local-project', project('local-project')],
      ['remote-project', project('remote-project')],
    ]);
    const groups = new ProjectGroupsStore();
    const sidebar = new SidebarStore({ projects } as unknown as ProjectManager);
    sidebar.machines = {
      machineOf: (id) => id === 'remote-project' ? 'other-device' : null,
      label: () => null, homeDir: () => null, connected: () => false,
      projectGroupOf: (id) => groups.chatIdOf(id),
    };
    const sessions = () => [{ projectId: 'hidden-project', sessionId: 'session-agent', agentUserId: 'agent' }];
    groups.start(() => [], sessions, () => sidebar.sidebarProjects.map(({ id }) => id));
    await vi.waitFor(() => expect(groups.bindingKnown('local-project')).toBe(true));
    groups.applyBindings(null, ['local-project', 'remote-project', 'hidden-project'].map((projectId) => ({ projectId, chatId: 'shared-group' })));

    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['local-project']);
    expect([...readProjectGroupChats()]).toEqual(['shared-group']);
    expect(groups.rowProjectOfChat('shared-group')).toBe('local-project');
    expect(readProjectGroupMembers().get('shared-group')).toEqual(['agent']);
    runInAction(() => projects.delete('local-project'));
    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['remote-project']);
    expect([...readProjectGroupChats()]).toEqual(['shared-group']);
    expect(groups.rowProjectOfChat('shared-group')).toBe('remote-project');
    runInAction(() => projects.delete('remote-project'));
    expect([...readProjectGroupChats()]).toEqual([]);
    expect(groups.rowProjectOfChat('shared-group')).toBeUndefined();
    expect(readProjectGroupMembers().get('shared-group')).toEqual(['agent']);
  });

  it('keeps human invitations disabled for a bound group without a project row', () => {
    projectGroupsStore.applyBindings(null, [{ projectId: 'hidden-project', chatId: 'hidden-group' }]);
    try {
      expect(projectGroupsStore.rowProjectOfChat('hidden-group')).toBeUndefined();
      expect(projectGroupsStore.projectOfChat('hidden-group')).toBe('hidden-project');
      expect(groupInviteAccess('hidden-group', 'group', { my_role: 'owner', can_manage: true, allow_member_invite: true }))
        .toEqual({ projectGroup: true, showInvite: true, canInviteHumans: false });
    } finally {
      projectGroupsStore.applyBindings(null, []);
    }
  });
});
