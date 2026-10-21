// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { homeProjectIdOn } from '../../../apps/desktop/src/mobile/assistant/phoneMachine'

// #7199 实机(OnePlus 8T)录音传不上去:云上的记忆夹在助理工作目录那个项目的工作区之外,写 / 建夹 / 分块上传只认工作区之内
// ⇒ 手机要像桌面(ensureHomeProject)那样用主目录项目。这里测「找 / 建主目录项目」那一步。
function rpcWith(opts: { existing?: string | null; conflict?: boolean; createFails?: boolean }) {
  const createProject = vi.fn(async (input: { id: string }) => (opts.createFails ? { success: false, error: { type: 'path-not-found' } } : { success: true, data: { id: input.id } }))
  const inspectProjectPath = vi.fn(async () => ({
    existingProject: opts.existing ? { id: opts.existing } : null,
    pathConflict: opts.conflict ? { type: 'nested' } : null,
  }))
  return { rpc: { projects: { inspectProjectPath, createProject } } as never, createProject, inspectProjectPath }
}

describe('homeProjectIdOn', () => {
  it('那台机器上主目录已经是项目:复用它,❌ 再建一个', async () => {
    const { rpc, createProject, inspectProjectPath } = rpcWith({ existing: 'project-home' })
    await expect(homeProjectIdOn(rpc, '/home/wuying')).resolves.toBe('project-home')
    expect(inspectProjectPath).toHaveBeenCalledWith({ type: 'local', path: '/home/wuying' })
    expect(createProject).not.toHaveBeenCalled()
  })

  it('还没有:把主目录登记成项目(不新建目录、不 git init、不要求是 git 仓库)', async () => {
    const { rpc, createProject } = rpcWith({})
    const id = await homeProjectIdOn(rpc, '/home/wuying/')
    expect(id).toMatch(/[0-9a-f-]{36}/)
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ type: 'local', path: '/home/wuying/', name: 'wuying', createDirectory: false, initGitRepository: false, allowNonGit: true }))
  })

  it('路径与别的项目冲突 / 建不成:如实抛出,❌ 退回别的项目去写(会写到工作区之外失败)', async () => {
    await expect(homeProjectIdOn(rpcWith({ conflict: true }).rpc, '/home/wuying')).rejects.toThrow(/conflict/)
    await expect(homeProjectIdOn(rpcWith({ createFails: true }).rpc, '/home/wuying')).rejects.toThrow(/could not add/)
  })
})
