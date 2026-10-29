// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  index: null as string | null,
  readFails: false,
  dirs: new Set<string>(),
  discarded: [] as string[],
  writes: [] as string[],
  lists: [] as { disabled: string[] }[],
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    async readIndex() {
      if (shell.readFails) throw new Error('index.json: I/O error')
      return { json: shell.index }
    },
    async writeIndex({ json }: { json: string }) { shell.writes.push(json); shell.index = json },
    async list() { return { dirs: [...shell.dirs], stages: 0 } },
    async discard({ dir }: { dir: string }) { shell.discarded.push(dir); shell.dirs.delete(dir) },
    async readText() { return { text: '' } },
    async writeText() {},
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => ({}) }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { applyList: (list: { disabled: string[] }) => shell.lists.push(list) },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneMarket', () => ({
  phoneMarket: () => ({ onRefreshed: () => () => {}, refresh: async () => {} }),
}))

const RECORD = { dir: 'notes@1.0.0', manifest: { id: 'notes' }, runtimeTag: '', pages: [], icons: {}, publisher: { id: 'p', name: 'p' } }

/**
 * #607 follow-up: an index the phone cannot read (not JSON, a list in it garbled, or the shell failing to read it) used to be
 * taken as empty, written back, and every installed App's files deleted with it. Now it is left as it is: nothing written,
 * nothing deleted, every change refused until it is read again; what was switched off stays off.
 */
async function load() {
  vi.resetModules()
  const { phoneApps } = await import('../../../../apps/desktop/src/components/appSlot/phoneApps')
  await phoneApps.ready()
  return phoneApps
}

beforeEach(() => {
  shell.readFails = false
  shell.dirs = new Set(['notes@1.0.0'])
  shell.discarded = []
  shell.writes = []
  shell.lists = []
  localStorage.clear()
  vi.stubGlobal('fetch', async () => new Response('[]'))
})

const STORED = JSON.stringify({ version: 1, installed: { notes: RECORD }, serve: {}, disabled: [] })

it('an index that is not JSON is left as it is: nothing written, no App deleted, every change refused', async () => {
  shell.index = STORED.slice(0, -5)
  const apps = await load()
  expect(apps.unreadable()).not.toBeNull()
  expect(shell.writes).toEqual([])
  expect(shell.discarded).toEqual([])
  expect(shell.index).toBe(STORED.slice(0, -5))
  expect((await apps.setEnabled('notes', false)).success).toBe(false)
  expect((await apps.uninstall('notes')).success).toBe(false)
  expect((await apps.firstRun.set({ state: 'existing' })).success).toBe(false)
  expect(shell.writes).toEqual([])
})

it('a garbled switched-off list keeps what was last switched off, and the Apps it names are still drawn', async () => {
  shell.index = STORED
  await load()
  expect(localStorage.getItem('gugu.phoneApps.disabled')).toBe('[]')
  const apps = await load()
  expect((await apps.setEnabled('notes', false)).success).toBe(true)
  shell.index = JSON.stringify({ ...JSON.parse(shell.index!), disabled: 'garbled' })
  shell.writes = []
  const again = await load()
  expect(again.unreadable()).not.toBeNull()
  expect(shell.lists.at(-1)?.disabled).toEqual(['notes'])
  expect(shell.writes).toEqual([])
})

it('nothing kept to go by: every App installed is off (fail closed)', async () => {
  shell.index = JSON.stringify({ version: 1, installed: { notes: RECORD }, serve: {}, autoUpdateOff: 7 })
  await load()
  expect(shell.lists.at(-1)?.disabled).toEqual(['notes'])
})

it('the shell failing to read it: the shipped Apps are drawn, and 重试 reads it again once it can', async () => {
  shell.readFails = true
  shell.index = STORED
  const apps = await load()
  expect(apps.unreadable()).toMatch(/I\/O error/)
  expect(shell.writes).toEqual([])
  shell.readFails = false
  await apps.reload()
  expect(apps.unreadable()).toBeNull()
  expect((await apps.setEnabled('notes', false)).success).toBe(true)
})

it('[positive control] a readable index is written back and what it does not name goes, as before', async () => {
  shell.dirs.add('old@0.9.0')
  shell.index = STORED
  await load()
  expect(shell.writes).toHaveLength(1)
  expect(shell.discarded).toEqual(['old@0.9.0'])
})
