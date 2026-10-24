import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { openingAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-cache'
import type { AssistantStartupIndexDeps } from '../../../apps/desktop/electron/sessionpage/assistant-startup-index'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-opening-')); roots.push(root)
  let owner = 'owner-a'
  let projectName = 'original-project'
  let clock = new Date('2026-10-24T10:00:00Z')
  const host = { device_id: 'host', label: 'original-device', platform: 'linux', online: true,
    last_seen_at: null as string | null, this_machine: true, kind: 'server' }
  const gate = Promise.withResolvers<void>()
  const run = vi.fn<AssistantStartupIndexDeps['run']>(async action => {
    if (action.action === 'devices') { await gate.promise; return [host] }
    if (action.action === 'device_actions') return { devices: [host] }
    if (action.action === 'project_list') return [{ project_id: 'p', name: projectName, path: '/project' }]
    if (action.action === 'library_read') return { items: [] }
    throw new Error('Unexpected action')
  })
  const deps = { accountId: async () => owner, run, timeoutMs: 15_000, now: () => clock }
  const saved = async () => {
    let file = ''
    await vi.waitFor(async () => {
      const files = await readdir(join(root, 'assistant-context'))
      file = files.find(name => name.endsWith('.json')) ?? ''; expect(file).not.toBe('')
    })
    return JSON.parse(await readFile(join(root, 'assistant-context', file), 'utf8'))
  }
  return { root, deps, gate, run, saved, setOwner: (value: string) => { owner = value },
    heartbeat: () => { clock = new Date(clock.getTime() + 30_000); host.last_seen_at = clock.toISOString() },
    renameProject: () => { projectName = 'renamed-project' } }
}

it('opens before an unresolved remote discovery and never claims the missing inventory is empty', async () => {
  const f = await fixture()
  try {
    const opening = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
    expect(opening.index).toContain('"status":"not_loaded"')
    expect(opening.index).not.toContain('"devices":[]')
    expect(opening.index).toContain('未载入不表示不存在')
    expect(opening.index).not.toContain('original-project')
  } finally { f.gate.resolve() }
  expect((await f.saved()).index).toContain('original-project')
})

it('uses only the matching account/workspace snapshot, labels it cached, and keeps its timestamp', async () => {
  const f = await fixture()
  const initial = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  f.gate.resolve()
  await initial.refreshed
  const saved = await f.saved()
  const opening = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  expect(opening.index).toContain('"status":"cached"')
  expect(opening.index).toContain(saved.observedAt)
  expect(opening.index).toContain('original-device')
  expect(opening.index).toContain('缓存不是当前在线或授权证明')
  expect(opening.index.length).toBeLessThanOrEqual(6000)
  const other = await openingAssistantIndex(f.root, '/another-assistant', 'cloud', f.deps)
  expect(other.index).toContain('"status":"not_loaded"')
  expect(other.index).not.toContain('original-project')
  await Promise.all([opening.refreshed, other.refreshed])
  expect((await readdir(join(f.root, 'assistant-context'))).filter(name => name.endsWith('.json'))).toHaveLength(2)
})

it('does not expose or save the old account when it changes during discovery', async () => {
  const f = await fixture()
  try {
    const initial = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
    f.setOwner('owner-b')
    const opening = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
    expect(opening.index).toContain('user:owner-b')
    expect(opening.index).not.toContain('user:owner-a')
    f.gate.resolve()
    await Promise.all([initial.refreshed, opening.refreshed])
    const saved = await f.saved()
    expect(saved.account).toBe('owner-b')
    expect((await readdir(join(f.root, 'assistant-context'))).filter(name => name.endsWith('.json'))).toHaveLength(1)
  } finally { f.gate.resolve() }
})

it('keeps the system suffix byte-stable for heartbeats and changes it only for changed resources', async () => {
  const f = await fixture()
  const first = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  f.gate.resolve()
  await first.refreshed
  f.heartbeat()
  const before = await f.saved()
  const cached = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  await cached.refreshed
  expect(await f.saved()).toEqual(before)
  const same = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  await same.refreshed
  expect(same.index).toBe(cached.index)
  f.renameProject()
  const updating = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  await updating.refreshed
  const changed = await openingAssistantIndex(f.root, '/assistant', 'cloud', f.deps)
  await changed.refreshed
  expect(changed.index).toContain('renamed-project')
  expect(changed.index).not.toBe(same.index)
  expect(changed.index.match(/<gugu_resource_index>/g)).toHaveLength(1)
})
