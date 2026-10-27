// 手机项目群派「新任务」浮出来的文件夹卡列什么(OpenDCAI/gugu#446,spec mobile-session-view「新任务照电脑」):
// 项目记在账号上、不归哪台机器 ⇒ 绑着这个群的本地项目,哪台机器上的都列;离线的照列、标离线;没绑 = 不是项目群。
import { describe, expect, it } from 'vitest'
import type { Device } from '../../../packages/core/src/shared/types/chat'
import type { DeviceProject } from '../../../packages/core/src/shared/types/deviceProject'
import { taskFoldersOfChat } from '../../../apps/desktop/src/mobile/chat/phoneTaskFolders'

const project = (over: Partial<DeviceProject>): DeviceProject => ({
  localProjectId: 'p', name: '登录改版', rootPath: '/r', createdAt: '2026-10-26T00:00:00.000Z', chatId: 'g1',
  groupRepresentative: false, folders: [], ...over,
})
const device = (id: string, online: boolean, projects: DeviceProject[], hostKind: 'desktop' | 'server' = 'desktop'): Device => ({
  device_id: id, label: id === 'mac' ? 'MacBook' : '', hostname: `${id}.local`, platform: 'darwin', status: 'active' as Device['status'],
  last_seen_at: '2026-10-26T00:00:00.000Z', is_online: online,
  capabilities: { host_kind: hostKind } as Device['capabilities'], projects,
})

describe('taskFoldersOfChat', () => {
  it('lists the folders of every local project bound to the group, on every machine, offline ones marked', () => {
    const got = taskFoldersOfChat([
      device('mac', true, [project({ localProjectId: 'p-mac', folders: [
        { workspaceId: 'w1', kind: 'root', path: '/Users/a/login', attachedAt: null },
        { workspaceId: 'w2', kind: 'attached', path: '/Users/a/login-api', attachedAt: '2026-10-25T00:00:00.000Z' },
      ] })]),
      device('box', false, [project({ localProjectId: 'p-box', groupRepresentative: true, folders: [
        { workspaceId: 'w3', kind: 'root', path: '/srv/login', attachedAt: null },
      ] })], 'server'),
      device('other', true, [project({ localProjectId: 'p-x', chatId: 'g2', folders: [{ workspaceId: 'w9', kind: 'root', path: '/x', attachedAt: null }] })]),
    ], 'g1')!
    expect(got.folders.map((folder) => [folder.workspaceId, folder.projectId, folder.offline])).toEqual([
      ['w1', 'p-mac', false], ['w2', 'p-mac', false], ['w3', 'p-box', true],
    ])
    expect(got.memberIds).toEqual(['p-mac', 'p-box'])
    expect(got.rowId, 'the machine-marked representative names the card').toBe('p-box')
    expect(got.homeOf('p-mac')).toEqual({ deviceId: 'mac', localProjectId: 'p-mac', machine: { id: 'mac', label: 'MacBook', online: true, kind: 'computer' } })
    expect(got.homeOf('p-box')?.machine, 'no label falls back to the hostname').toEqual({ id: 'box', label: 'box.local', online: false, kind: 'server' })
  })

  it('a group no machine has bound is not a project group', () => {
    expect(taskFoldersOfChat([device('mac', true, [project({ chatId: 'g2' })]), device('new', true, [])], 'g1')).toBeNull()
  })
})
