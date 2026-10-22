// #113 账号上记着的一台机器的项目,换成会话页里的那几样形状;手机上离线机器的项目照它列全。
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@gugu/core/shared/types/chat';
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@shared/core/projects/session-home-project';
import { deviceSessionsOf } from '@/session/shared/remote-sessions/session-directory';
import {
  accountBindingsOf,
  accountFoldersOf,
  accountProjectsOf,
  forgetRetiredProjectCaches,
  machineTimestamp,
} from './account-projects';

const record = (overrides: Partial<DeviceProject> = {}): DeviceProject => ({
  localProjectId: 'proj-repo-1',
  name: 'repo',
  rootPath: '/srv/repo',
  createdAt: '2026-10-01T08:00:00.000Z',
  chatId: 'chat-repo',
  groupRepresentative: false,
  folders: [
    { workspaceId: 'ws-root', kind: 'root', path: '/srv/repo', attachedAt: null },
    { workspaceId: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attachedAt: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
});

describe('账号上那份 → 会话页的形状', () => {
  it('项目清单:与那台机器的回答同一个写法(侧栏才能和别的项目一起按建立时间排)', () => {
    expect(accountProjectsOf('dev-1', [record()])).toEqual([{
      type: 'local',
      id: 'proj-repo-1',
      name: 'repo',
      path: '/srv/repo',
      baseRef: null,
      repositoryWorkspaceId: 'ws-root',
      createdAt: '2026-10-01 08:00:00',
      updatedAt: '2026-10-01 08:00:00',
    }]);
    expect(machineTimestamp('2026-10-01T08:00:00+08:00')).toBe('2026-10-01 00:00:00');
  });

  it('摘了根目录的项目如实标出来', () => {
    const [project] = accountProjectsOf('dev-1', [record({ folders: [record().folders[1]!] })]);
    expect(project).toMatchObject({ repositoryWorkspaceId: null, rootFolderDetached: true });
  });

  it('那台机器的隐藏任务工作区换成这边认得的名字(与经那台机器的连接读到的同一个)', () => {
    const home = record({ localProjectId: IMPLICIT_SESSION_HOME_PROJECT_ID, chatId: null });
    expect(accountProjectsOf('dev-1', [home])[0]?.id).toBe(`${IMPLICIT_SESSION_HOME_PROJECT_ID}~dev-1`);
    expect(accountFoldersOf('dev-1', [home], `${IMPLICIT_SESSION_HOME_PROJECT_ID}~dev-1`)?.[0]?.projectId).toBe(
      `${IMPLICIT_SESSION_HOME_PROJECT_ID}~dev-1`
    );
  });

  it('群绑定:没绑的不出,代表那一个带上标记', () => {
    expect(accountBindingsOf('dev-1', [record({ groupRepresentative: true }), record({ localProjectId: 'proj-free-2', chatId: null })])).toEqual([
      { projectId: 'proj-repo-1', chatId: 'chat-repo', representative: true },
    ]);
  });

  it('文件夹:分支与会话这两个此刻的读数是空的,❌ 编一个;账号上没有这个项目 = null', () => {
    expect(accountFoldersOf('dev-1', [record()], 'proj-repo-1')).toEqual([
      { workspaceId: 'ws-root', projectId: 'proj-repo-1', kind: 'root', path: '/srv/repo', branch: null, sessionIds: [], attachedAt: null },
      { workspaceId: 'ws-wt', projectId: 'proj-repo-1', kind: 'attached', path: '/srv/repo-wt', branch: null, sessionIds: [], attachedAt: '2026-10-02T00:00:00.000Z' },
    ]);
    expect(accountFoldersOf('dev-1', [record()], 'proj-elsewhere')).toBeNull();
  });

  it('开机清掉每台桌面从前各记一份的那几样', () => {
    const removeItem = vi.fn();
    forgetRetiredProjectCaches({ removeItem });
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      'gugu:machine-projects:v1',
      'gugu:machine-home-dirs:v1',
      'gugu.projectGroups.v1',
      'gugu.projectFolders.v1',
    ]);
  });
});

describe('手机:离线机器上的项目照账号上那份列全', () => {
  const device = (overrides: Partial<Device> = {}): Device => ({
    device_id: 'dev-1',
    label: 'd22',
    hostname: 'd22',
    platform: 'linux',
    status: 'offline',
    last_seen_at: '2026-10-22T00:00:00Z',
    is_online: false,
    capabilities: { terminals: [], runtimes: [] },
    session_digest: [{
      conversationId: 's1', projectId: 'proj-digest-only', projectName: 'scratch', title: 't', harness: 'codex', agentStatus: null,
      lastInteractedAt: null, supported: true,
    }] as Device['session_digest'],
    ...overrides,
  });

  it('没有会话的项目也列出来;摘要里的会话所在的项目照样有归处', () => {
    const sessions = deviceSessionsOf(device({ projects: [record()] }), {});
    expect(sessions.projects).toEqual([
      { id: 'proj-repo-1', name: 'repo', path: '/srv/repo' },
      { id: 'proj-digest-only', name: 'scratch', path: '' },
    ]);
    expect(sessions.sessions.map((session) => session.conversationId)).toEqual(['s1']);
  });

  it('还没读到账号上那份:照旧只有摘要里的', () => {
    expect(deviceSessionsOf(device(), {}).projects).toEqual([{ id: 'proj-digest-only', name: 'scratch', path: '' }]);
  });
});
