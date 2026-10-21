import { isFileNotFoundError, type IFileSystem } from '@gugu/session-core/files'
import type { RuntimePath } from '@main/core/runtime/types'
import type { Project } from '@shared/projects'

/** Registered Git projects point at their repository root, not an ancestor repo. */
export async function resolveProjectGitless(
  project: Pick<Project, 'path' | 'baseRef'>,
  files: Pick<IFileSystem, 'stat'>,
  paths: Pick<RuntimePath, 'join'>
): Promise<boolean> {
  if (project.baseRef === null) return true
  return projectDirectoryHasNoGit(project.path, paths.join(project.path, '.git'), files)
}

export async function projectDirectoryHasNoGit(
  projectPath: string,
  metadataPath: string,
  files: Pick<IFileSystem, 'stat'>
): Promise<boolean> {
  const metadata = await files.stat(metadataPath)
  // A .git file is valid for linked worktrees. Existing but damaged metadata
  // still goes through Git and reports its error instead of silently degrading.
  if (metadata.success) return false
  if (!isFileNotFoundError(metadata.error)) throw new Error(metadata.error.message)

  const directory = await files.stat(projectPath)
  if (!directory.success) throw new Error(directory.error.message)
  if (directory.data.type !== 'directory') {
    throw new Error(`Project path is not a directory: ${projectPath}`)
  }
  return true
}
