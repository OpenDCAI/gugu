import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FilesRuntime, type FileChangeUpdate } from '@gugu/session-core/files'
import { watchWorkspaceDirectory } from '../../../apps/desktop/electron/session/main/core/workspaces/workspace-directory-watch'

it('delivers actual writes outside the workspace and releases that directory subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-external-memory-'))
  const runtime = new FilesRuntime()
  let release: (() => void) | undefined
  try {
    const project = join(root, 'project'), memory = join(root, 'memory')
    await mkdir(project); await mkdir(memory)
    const changed = vi.fn<(update: FileChangeUpdate) => void>()
    const watched = await watchWorkspaceDirectory(runtime, project, memory, changed)
    expect(watched.success).toBe(true)
    if (!watched.success) throw new Error(watched.error.message)
    release = watched.data
    await writeFile(join(memory, 'preference.md'), 'new preference')
    const file = join(await realpath(memory), 'preference.md')
    await vi.waitFor(() => expect(changed.mock.calls.some(([update]) => update.kind === 'changes'
      && update.changes.some(change => change.path === file))).toBe(true), { timeout: 5000 })
  } finally { release?.(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('rejects a missing external directory instead of reporting a live lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-missing-memory-'))
  const runtime = new FilesRuntime()
  try {
    const watched = await watchWorkspaceDirectory(runtime, root, join(root, '..', 'missing-' + Date.now()), vi.fn())
    expect(watched.success).toBe(false)
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})
