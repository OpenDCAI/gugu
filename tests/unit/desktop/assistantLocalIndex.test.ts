import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { assistantLocalIndex } from '../../../apps/desktop/electron/sessionpage/assistant-local-index'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it.each(['computer', 'cloud'] as const)('indexes the real %s assistant paths without reading personal or credential bodies', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-local-')); roots.push(root)
  const cwd = join(root, 'assistant')
  const paths = assistantHomePaths(root, cwd, kind)
  await mkdir(paths.memoryDir, { recursive: true })
  await mkdir(paths.resourcesDir, { recursive: true })
  await mkdir(join(paths.resourcesDir, 'folder'))
  await writeFile(join(paths.memoryDir, 'preferences.md'), 'PRIVATE-MEMORY-BODY')
  await writeFile(paths.instructions, 'PRIVATE-PERSONALITY-BODY')
  const rows = await assistantLocalIndex(cwd, kind, root, async () => [{ id: 'email:mine', name: 'email', modifiedAt: '2026-10-21T00:00:00.000Z' }])
  expect(rows.find(row => row.source === 'assistant_memory')?.items).toEqual([expect.objectContaining({ name: 'preferences.md', path: join(paths.memoryDir, 'preferences.md') })])
  expect(rows.find(row => row.source === 'assistant_personality')?.items?.[0].path).toBe(paths.instructions)
  expect(rows.find(row => row.source === 'assistant_files')?.items?.[0].name).toBe('folder')
  expect(rows.find(row => row.source === 'integrations')?.read).toContain('不等于')
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-')
  await rm(join(paths.memoryDir, 'preferences.md'))
  expect((await assistantLocalIndex(cwd, kind, root, async () => [])).find(row => row.source === 'assistant_memory')?.items).toEqual([])
})

it('distinguishes missing folders from failed reads and failed integration enumeration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-local-')); roots.push(root)
  const paths = assistantHomePaths(root, root, 'computer')
  const first = await assistantLocalIndex(root, 'computer', root, async () => { throw new Error('private auth detail') })
  expect(first.find(row => row.source === 'assistant_memory')).toMatchObject({ status: 'read', items: [] })
  expect(first.find(row => row.source === 'integrations')).toMatchObject({ status: 'unavailable' })
  await mkdir(join(root, '.claude'))
  await writeFile(paths.memoryDir, 'directory replaced by invalid file')
  const broken = await assistantLocalIndex(root, 'computer', root, async () => [])
  expect(broken.find(row => row.source === 'assistant_memory')).toMatchObject({ status: 'unavailable' })
  expect(broken.find(row => row.source === 'assistant_memory')?.items).toBeUndefined()
  expect(JSON.stringify(first)).not.toContain('private auth detail')
})
