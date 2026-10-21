import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileSystem } from '@gugu/session-core/files'
import { ok } from '@gugu/session-shared'
import type { MachineRuntime } from '@main/core/runtime/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireWorkspaceRuntime } from './workspace-runtime'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-gitless-'))
  tempDirs.push(root)
  const releaseRuntime = vi.fn()
  const releaseWorktree = vi.fn()
  const releaseTree = vi.fn()
  const fileSystem = new FileSystem()
  const openWorktree = vi.fn(async () => ({ value: { marker: 'git' }, release: releaseWorktree }))
  const openTree = vi.fn(async () => ok({ value: { marker: 'files' }, release: releaseTree }))
  const runtime = {
    files: { path, fileSystem: () => ok(fileSystem), openTree },
    git: { openWorktree }
  } as unknown as MachineRuntime
  const manager = { acquire: vi.fn(async () => ({ value: runtime, release: releaseRuntime })) }
  return {
    root,
    runtime,
    manager,
    fileSystem,
    openWorktree,
    openTree,
    releaseRuntime,
    releaseTree,
    releaseWorktree
  }
}

describe('workspace acquisition after Git metadata changes', () => {
  it('uses the files runtime when a previously Git-backed project loses .git', async () => {
    const f = await fixture()
    await fs.mkdir(path.join(f.root, '.git'))
    await fs.rename(path.join(f.root, '.git'), path.join(f.root, 'saved-git'))
    const acquired = await acquireWorkspaceRuntime(
      { manager: f.manager },
      f.root,
      false,
      f.root
    )
    expect(f.openWorktree).not.toHaveBeenCalled()
    expect(f.openTree).toHaveBeenCalledWith(f.root)
    expect(acquired.gitWorktree).toBeUndefined()
    const write = await acquired.filesRuntime.fileSystem()
    if (!write.success) throw new Error(write.error.message)
    expect(
      (await write.data.writeText(path.join(f.root, 'task-output.txt'), 'task still works')).success
    ).toBe(true)
    expect(await fs.readFile(path.join(f.root, 'task-output.txt'), 'utf8')).toBe('task still works')
    await acquired.release()
    await acquired.release()
    expect(f.releaseTree).toHaveBeenCalledTimes(1)
    expect(f.releaseRuntime).toHaveBeenCalledTimes(1)
  })

  it('keeps Git enabled when the project metadata exists', async () => {
    const f = await fixture()
    await fs.mkdir(path.join(f.root, '.git'))
    const acquired = await acquireWorkspaceRuntime(
      { manager: f.manager },
      f.root,
      false,
      f.root
    )
    expect(f.openWorktree).toHaveBeenCalledWith(f.root)
    expect(acquired.gitWorktree).toBeDefined()
    await acquired.release()
    expect(f.releaseWorktree).toHaveBeenCalledTimes(1)
  })

  it('propagates permission errors and releases the runtime', async () => {
    const f = await fixture()
    vi.spyOn(f.fileSystem, 'stat').mockResolvedValue({
      success: false,
      error: {
        type: 'fs-error',
        path: '/remote/project/.git',
        code: 'EACCES',
        message: 'Permission denied'
      }
    })
    await expect(
      acquireWorkspaceRuntime(
        { manager: f.manager },
        '/remote/project',
        false,
        '/remote/project'
      )
    ).rejects.toThrow('Permission denied')
    expect(f.openTree).not.toHaveBeenCalled()
    expect(f.openWorktree).not.toHaveBeenCalled()
    expect(f.releaseRuntime).toHaveBeenCalledTimes(1)
  })

  it('skips the project .git recheck when no project path is given', async () => {
    const f = await fixture()
    const stat = vi.spyOn(f.fileSystem, 'stat')
    const acquired = await acquireWorkspaceRuntime(
      { manager: f.manager },
      '/remote/checkout',
      false
    )
    expect(stat).not.toHaveBeenCalled()
    expect(f.openWorktree).toHaveBeenCalledWith('/remote/checkout')
    await acquired.release()
  })
})
