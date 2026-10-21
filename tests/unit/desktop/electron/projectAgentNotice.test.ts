import { describe, expect, it, vi } from 'vitest'
import { prepareProjectAgentNotice } from '../../../../apps/desktop/electron/sessionpage/project-agent-notice'

describe('project change announcements', () => {
  const result = { project_id: 'project', name: 'App', undo: { tool: 'project_restore_device' }, group_notice: { chat_id: 'group', text: '已关联设备' } }
  it('establishes access as the actual caller before telling it to post', async () => {
    const ensureAccess = vi.fn(async () => {})
    expect(await prepareProjectAgentNotice(result, { agentUserId: async () => 'agent', ensureAccess })).toMatchObject({ group_notice: { status: 'ready', next: expect.stringContaining('message_send') } })
    expect(ensureAccess).toHaveBeenCalledWith('agent', { projectId: 'project', projectName: 'App', chatId: 'group' })
  })
  it('preserves the committed operation and undo when joining fails; does not instruct posting', async () => {
    const answer = await prepareProjectAgentNotice(result, { agentUserId: async () => 'agent', ensureAccess: async () => { throw new Error('join denied') } })
    expect(answer).toMatchObject({ undo: result.undo, group_notice: { status: 'unavailable', error: 'join denied', next: expect.stringContaining('Do not repeat the mutation') } })
  })
  it('project_get can retry access without repeating a folder or device mutation', async () => {
    const ensureAccess = vi.fn(async () => {})
    expect(await prepareProjectAgentNotice({ project_id: 'project', name: 'App', chat_id: 'group' }, { agentUserId: async () => 'agent', ensureAccess })).toMatchObject({ group_access: { status: 'ready' } })
    expect(ensureAccess).toHaveBeenCalledOnce()
  })
})
