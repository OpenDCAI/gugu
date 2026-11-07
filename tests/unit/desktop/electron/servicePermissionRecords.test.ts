import { link, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivatePermissionRecords } from '../../../../apps/desktop/electron/permissions/private-records'
import { defaultPermissionPolicy, decidePermission } from '../../../../apps/desktop/electron/permissions/rules'
import { permissionOperation } from '../../../../apps/desktop/electron/permissions/operation'
import { filterPermissionResult } from '../../../../apps/desktop/electron/permissions/result-filter'
import { ServicePermissionPolicyStore } from '../../../../apps/desktop/electron/permissions/policy-store'
import type { VersionedSettingsTableClient } from '../../../../packages/core/src/cloud/userSettings'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const person = { kind: 'person' as const, userId: 'owner' }
const agent = { kind: 'agent' as const, userId: 'owner' }
const caller = { ownerId: 'owner', subjectId: 'agent-a', sessionId: 'task-a', toolScope: 'gugu' }
async function fixture(now?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-private-permissions-'))
  directories.push(directory)
  return { directory, records: new PrivatePermissionRecords(directory, now) }
}

describe('private service permission administration and records', () => {
  it('defaults off; only the owning person can change enforcement or read/clear records', async () => {
    const { records } = await fixture()
    expect(await records.enforcement('owner')).toBe(false)
    for (const principal of [agent, { kind: 'person' as const, userId: 'another-owner' }]) {
      await expect(records.setEnforcement(principal, 'owner', true)).rejects.toThrow('owning person')
      await expect(records.read(principal, 'owner')).rejects.toThrow('owning person')
      await expect(records.clear(principal, 'owner')).rejects.toThrow('owning person')
    }
    await records.setEnforcement(person, 'owner', true)
    expect(await records.enforcement('owner')).toBe(true)
    expect(await records.enforcement('another-owner')).toBe(false)
    await records.setEnforcement(person, 'owner', false)
    expect(await records.enforcement('owner')).toBe(false)
  })
  it('retains 90 days, keeps redacted targets private on disk, and clears only the selected owner', async () => {
    let now = new Date('2026-01-01T12:00:00Z')
    const { records, directory } = await fixture(() => now)
    const operation = permissionOperation(caller, 'message_send', { chat_id: 'private-chat', text: 'private body', password: 'canary-secret' })
    const decision = decidePermission({ operation, agentId: caller.subjectId, policy: defaultPermissionPolicy() })
    const entry = { id: 'record-a', phase: 'before' as const, mode: 'observe' as const, outcome: 'would_ask' as const, decision }
    await records.append(caller, operation, entry)
    now = new Date('2026-04-02T12:00:00Z')
    await records.append(caller, operation, { ...entry, id: 'record-b' })
    const rows = await records.read(person, 'owner')
    expect(rows.map(row => row.id)).toEqual(['record-b'])
    expect(JSON.stringify(rows)).not.toMatch(/private-chat|private body|canary-secret/)
    const ownerDirectory = join(directory, (await readdir(directory))[0]!)
    if (process.platform !== 'win32') {
      expect((await stat(ownerDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(ownerDirectory, '2026-04-02.jsonl'))).mode & 0o777).toBe(0o600)
    }
    const other = { ...caller, ownerId: 'another-owner' }
    await records.append(other, operation, entry)
    await records.clear(person, 'owner')
    expect(await records.read(person, 'owner')).toEqual([])
    expect(await records.read({ kind: 'person', userId: 'another-owner' }, 'another-owner')).toHaveLength(1)
  })
  it('does not silently disable enforcement on a corrupt switch', async () => {
    const { records, directory } = await fixture()
    await records.setEnforcement(person, 'owner', true)
    const subdirectory = (await readdir(directory))[0]!
    await writeFile(join(directory, subdirectory, 'enforcement.json'), '{}')
    await expect(records.enforcement('owner')).rejects.toThrow('Malformed')
  })
  it('rejects reading or replacing an enforcement file with another hard-link name', async () => {
    const { records, directory } = await fixture()
    await records.setEnforcement(person, 'owner', false)
    const ownerDirectory = join(directory, (await readdir(directory))[0]!)
    const flag = join(ownerDirectory, 'enforcement.json')
    await link(flag, join(directory, 'outside-alias'))
    await expect(records.enforcement('owner')).rejects.toThrow('single link')
    await expect(records.setEnforcement(person, 'owner', true)).rejects.toThrow('single link')
    expect(JSON.parse(await readFile(flag, 'utf8'))).toEqual({ enabled: false })
  })
  it('does not append to or unlink a journal with a pre-existing hard-link alias', async () => {
    const { records, directory } = await fixture()
    const operation = permissionOperation(caller, 'guide_topics', {})
    const decision = decidePermission({ operation, agentId: caller.subjectId, policy: defaultPermissionPolicy() })
    const entry = { id: 'one', phase: 'before' as const, mode: 'observe' as const, outcome: 'would_allow' as const, decision }
    await records.append(caller, operation, entry)
    const ownerDirectory = join(directory, (await readdir(directory))[0]!)
    const journal = join(ownerDirectory, (await readdir(ownerDirectory)).find(name => name.endsWith('.jsonl'))!)
    const before = await readFile(journal, 'utf8')
    await link(journal, join(directory, 'outside-alias'))
    await expect(records.read(person, 'owner')).rejects.toThrow('single link')
    await expect(records.append(caller, operation, { ...entry, id: 'two' })).rejects.toThrow('single link')
    await expect(records.clear(person, 'owner')).rejects.toThrow('single link')
    expect(await readFile(journal, 'utf8')).toBe(before)
  })
  it('publishes one complete target key during simultaneous first writes from two store instances', async () => {
    const { records, directory } = await fixture()
    const other = new PrivatePermissionRecords(directory)
    const operation = permissionOperation(caller, 'message_send', { chat_id: 'private-chat' })
    const decision = decidePermission({ operation, agentId: caller.subjectId, policy: defaultPermissionPolicy() })
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? records : other).append(caller, operation, {
      id: String(index), phase: 'before', mode: 'observe', outcome: 'would_ask', decision,
    })))
    const rows = await records.read(person, 'owner')
    expect(rows).toHaveLength(8)
    expect(new Set(rows.map(row => row.target)).size).toBe(1)
    expect(rows.every(row => row.agent === 'agent-a' && row.session === 'task-a')).toBe(true)
  })
  it('has a person-only policy write boundary before any database access', async () => {
    const from = vi.fn(() => { throw new Error('must not reach the database') })
    const store = new ServicePermissionPolicyStore({ from } as unknown as VersionedSettingsTableClient)
    await expect(store.write(agent, 'owner', defaultPermissionPolicy())).rejects.toThrow('owning person')
    await expect(store.write({ kind: 'person', userId: 'other' }, 'owner', defaultPermissionPolicy())).rejects.toThrow('owning person')
    expect(from).not.toHaveBeenCalled()
  })
  it('filters structured credentials, bearer values and known tokens, preserving ordinary values and image bytes', () => {
    const value = { content: [ { type: 'text', text: JSON.stringify({ password: 'canary-secret', nested: { refresh_token: 'second-token' }, ordinary: 'normal' }) },
      { type: 'text', text: 'Authorization: Bearer another-token known-token' }, { type: 'image', data: 'known-token', mimeType: 'image/png' } ] }
    const filtered = filterPermissionResult(value, ['known-token']) as typeof value
    expect(filtered.content[0]!.text).toContain('normal')
    expect(filtered.content[0]!.text).not.toMatch(/canary-secret|second-token/)
    expect(filtered.content[1]!.text).not.toMatch(/another-token|known-token/)
    expect(filtered.content[2]!.data).toBe('known-token')
  })
  it('does not mix the enforcement file into the person record reader', async () => {
    const { records, directory } = await fixture()
    await records.setEnforcement(person, 'owner', true)
    const ownerDirectory = join(directory, (await readdir(directory))[0]!)
    expect(JSON.parse(await readFile(join(ownerDirectory, 'enforcement.json'), 'utf8'))).toEqual({ enabled: true })
    expect(await records.read(person, 'owner')).toEqual([])
  })
})
