import { mkdtemp, mkdir, rm, writeFile, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHostLocalSessionSource, type HostLocalSessionSource } from '../../../../apps/desktop/electron/sessionpage/local-session-source'

const roots: string[] = []
const sources: HostLocalSessionSource[] = []
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reads only an indexed source/path, pages turns, and retains the realpath boundary after indexing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-sessions-'))
  roots.push(root)
  const native = join(root, 'native')
  await mkdir(join(native, 'projects'), { recursive: true })
  const filePath = join(native, 'projects', 'main.jsonl')
  await writeFile(filePath, [
    { type: 'user', sessionId: 'main', cwd: '/project', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  ].map((entry) => JSON.stringify(entry)).join('\n'))
  const source = createHostLocalSessionSource(root, { nativeHomes: { 'claude-code': [native], codex: [native] } })
  sources.push(source)
  const read = { filePath, source: 'claude-code' as const }
  await expect(source.read(read)).rejects.toMatchObject({ code: 'not-found' })
  const index = await source.list({ cwd: '/project', limit: 1 })
  expect(index.rows.map((row) => row.filePath)).toEqual([filePath])
  expect((await source.list({ cwd: '/other' })).rows).toEqual([])
  expect((await source.list({ cwd: '/project', offset: 1 })).rows).toEqual([])
  const page = await source.read({ ...read, limit: 1 })
  expect(page).toMatchObject({ total: 2, nextOffset: 1, turns: [{ content: 'hello' }] })
  expect(await source.read({ ...read, limit: 1, offset: 1 })).toMatchObject({ total: 2, nextOffset: null, turns: [{ content: 'answer' }] })
  await expect(source.read({ ...read, source: 'codex' })).rejects.toMatchObject({ code: 'not-found' })
  const outside = join(root, 'outside.jsonl')
  await writeFile(outside, 'private outside content')
  await unlink(filePath)
  await symlink(outside, filePath)
  await expect(source.read(read)).rejects.toThrow(/扫描目录/)
})
