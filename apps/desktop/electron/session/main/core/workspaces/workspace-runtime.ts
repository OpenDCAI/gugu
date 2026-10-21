import type { RuntimeManager } from '@main/core/runtime/types'
import { projectDirectoryHasNoGit } from '../projects/resolve-project-gitless'

export async function acquireWorkspaceRuntime(
  workspaceRuntime: { manager: Pick<RuntimeManager, 'acquire'> },
  workDir: string,
  // gugu #2358: 非 git 项目的目录不是 git 仓,openWorktree 会抛 → 跳过,gitWorktree 缺省。
  // 会话的对话/终端 provider 不依赖 git,fileTree/filesRuntime 照常打开,agent 直接在目录里跑。
  gitless: boolean,
  projectPath?: string
) {
  const runtimeLease = await workspaceRuntime.manager.acquire()
  try {
    const files = runtimeLease.value.files
    const opened = files.fileSystem()
    if (!opened.success) throw new Error(opened.error.message)
    // Metadata can disappear after the project was mounted. Recheck when a new
    // workspace is acquired without tearing down any already running sessions.
    const currentlyGitless =
      gitless ||
      (projectPath !== undefined &&
        (await projectDirectoryHasNoGit(
          projectPath,
          files.path.join(projectPath, '.git'),
          opened.data
        )))
    const worktreeLease = currentlyGitless
      ? undefined
      : await runtimeLease.value.git.openWorktree(workDir)
    try {
      const openedFileTree = await runtimeLease.value.files.openTree(workDir)
      if (!openedFileTree.success) {
        throw new Error(`Failed to open file tree: ${JSON.stringify(openedFileTree.error)}`)
      }
      const fileTreeLease = openedFileTree.data

      let released = false
      return {
        gitWorktree: worktreeLease?.value,
        fileTree: fileTreeLease.value,
        filesRuntime: runtimeLease.value.files,
        release: async () => {
          if (released) return
          released = true
          await fileTreeLease.release()
          await worktreeLease?.release()
          await runtimeLease.release()
        }
      }
    } catch (error) {
      await worktreeLease?.release()
      throw error
    }
  } catch (error) {
    await runtimeLease.release()
    throw error
  }
}
