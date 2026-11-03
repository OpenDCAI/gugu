import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMoveJournalFileStore } from '../../../../apps/desktop/electron/assistant-move-journal'
import { durableMoveJournal } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move-journal'
import type { MoveJournal } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const record: MoveJournal = { assistantId: 'agent-1', direction: 'to-cloud', startedAt: 1, done: ['preflight'],
  source: { kind: 'computer', deviceId: 'local' }, schedules: [{ name: 'Daily', prompt: 'Report', triggerConfig: { expr: '0 8 * * *' }, enabled: true }] }
const emptyCache = () => ({ load: () => null, save: () => {}, clear: () => {} })

describe('native assistant move recovery', () => {
  it('reloads the original home and schedules from disk after losing every UI cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-move-')); roots.push(root)
    const native = createMoveJournalFileStore(root)
    const storage = { read: () => native.read('owner-1'), write: (raw: string) => native.write('owner-1', raw), clear: () => native.clear('owner-1') }
    await (await durableMoveJournal(emptyCache(), storage)).save(record)
    const reloaded = await durableMoveJournal(emptyCache(), storage)
    expect(reloaded.load()).toEqual(record)
    expect(await native.read('other-owner')).toBeNull()
    await reloaded.clear()
    expect(await native.read('owner-1')).toBeNull()
  })

  it('fails on corrupted recovery data without replacing it with an empty schedule list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-move-')); roots.push(root)
    await writeFile(join(root, 'owner-1.json'), '{broken')
    const native = createMoveJournalFileStore(root)
    await expect(durableMoveJournal(emptyCache(), { read: () => native.read('owner-1'), write: async () => {}, clear: async () => {} })).rejects.toThrow()
    expect(await readFile(join(root, 'owner-1.json'), 'utf8')).toBe('{broken')
    await expect(native.write('../escape', JSON.stringify(record))).rejects.toThrow('Invalid move journal owner')
  })
})
