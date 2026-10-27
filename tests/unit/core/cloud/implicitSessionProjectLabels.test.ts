import { describe, expect, it } from 'vitest'
import { normalizeSessionDigest } from '@gugu/core/cloud/devices'

const implicitId = '00000000-0000-4000-8000-000000000001'
const row = (projectId: string, projectName: string) => ({ conversationId: 'task', title: 'Actual task', projectId, projectName })
describe('session discovery does not present internal task workspaces as user projects', () => {
  it('removes the internal project label from an existing cloud digest without dropping the task', () => {
    const source = row(implicitId, '任务工作区')
    expect(normalizeSessionDigest([source])).toMatchObject([{ conversationId: 'task', title: 'Actual task', projectId: implicitId, projectName: '' }])
    expect(source.projectName).toBe('任务工作区')
  })
  it('keeps real projects, including a real project with the same name', () => {
    expect(normalizeSessionDigest([row('business-project', '任务工作区')])[0]?.projectName).toBe('任务工作区')
    expect(normalizeSessionDigest([row('assistant-home', '助理')])[0]?.projectName).toBe('助理')
  })
})
