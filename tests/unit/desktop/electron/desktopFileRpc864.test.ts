import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FILE_STORAGE } from '@gugu/core/shared/fileStorage'
import { createProjectFilePublisher } from '../../../../apps/desktop/electron/projectFilePublication'
import { signedInFileRpc } from '../../../../apps/desktop/electron/desktopFileAccess'
import { rememberProjectGroupId } from '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'
import { rpcQuery } from '../../../support/rpcQuery'

const ME = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const state = vi.hoisted(() => ({ row: {} as Record<string, unknown> }))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ rpc: rpcQuery(async (name: string) => {
    if (name === 'workspace_get_as') return { data: [state.row], error: null }
    throw new Error(`Unexpected App RPC ${name}`)
  }) }),
}))
const { createAppFiles } = await import('../../../../apps/desktop/src/session/shared/extensions/app-files-core')
const { bridgeFailure } = await import('../../../../apps/desktop/src/session/shared/extensions/bridge-protocol')

type Reply = { data: unknown; error: { message: string; code: string; details: string; hint: string } | null }
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
// The RPC main wires into desktopFiles (signedInFileRpc), replacing only auth and the network.
function desktopRpc(reply: (name: string, args: Record<string, unknown>) => Promise<Reply>, signedIn = true) {
  const network = vi.fn(reply), client = vi.fn(() => ({ rpc: network }))
  const rpc = signedInFileRpc(async () => signedIn ? { userId: ME, accessToken: 'fixture-token' } : null, client) as Rpc
  return { rpc, network, client }
}
const refusal = (message = 'Permission denied for file publication') => ({ message, code: '42501', details: 'The file was not changed', hint: 'workspace_not_member' })

describe('the desktop file RPC boundary', () => {
  it('throws an Error with the database message and structured diagnostics, retaining the original cause', async () => {
    const error = refusal(), f = desktopRpc(async () => ({ data: { item_id: ITEM }, error }))
    const caught = await f.rpc('file_device_publish', { p_item: ITEM }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject(error)
    expect((caught as Error).cause).toBe(error)
    expect(String(caught)).toBe(`Error: ${error.message}`)
    expect(f.network).toHaveBeenCalledExactlyOnceWith('file_device_publish', { p_item: ITEM })
    expect(f.client).toHaveBeenCalledExactlyOnceWith('fixture-token')
  })

  it('returns successful data unchanged', async () => {
    const data = { item_id: ITEM }, f = desktopRpc(async () => ({ data, error: null }))
    await expect(f.rpc('file_device_publish', {})).resolves.toBe(data)
  })

  it('refuses an unsigned reader without calling the database', async () => {
    const f = desktopRpc(async () => ({ data: null, error: null }), false)
    await expect(f.rpc('workspace_get_as', {})).rejects.toThrow('File reader is not signed in')
    expect(f.client).not.toHaveBeenCalled()
  })

  it('preserves an actual network rejection', async () => {
    const error = new Error('Connection reset'), f = desktopRpc(async () => { throw error })
    await expect(f.rpc('file_device_publish', {})).rejects.toBe(error)
  })
})

describe('database refusals reach the App through the real local publisher', () => {
  let home: string, root: string, env: NodeJS.ProcessEnv
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gugu-file-rpc-864-')); root = join(home, 'project'); env = { GUGU_HOME: home }
    await mkdir(root); await writeFile(join(root, 'report.pdf'), 'original')
    await rememberProjectGroupId('project', CHAT, ME, env)
    state.row = { id: ITEM, chat_id: CHAT, filename: 'report.pdf', kind: 'file', content_type: 'application/pdf', size_bytes: 8,
      version: 1, epoch: 0, pointer: null, parent_id: null, system_role: null, path: 'report.pdf', created_by: ME,
      source_message_ids: [], created_at: null, updated_at: null }
  })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  function app(error: ReturnType<typeof refusal>, concurrentVersion?: number) {
    const f = desktopRpc(async name => {
      if (name !== 'file_device_publish') throw new Error(`Unexpected publisher RPC ${name}`)
      if (concurrentVersion) state.row.version = concurrentVersion
      return { data: null, error }
    })
    const publish = createProjectFilePublisher({ identity: async () => ({ accountId: ME, deviceId: 'device' }),
      root: async () => root, rpc: f.rpc, env, storage: async () => DEFAULT_FILE_STORAGE, projectChat: async () => true })
    const files = createAppFiles({ publishFile: publish, account: async () => ({ token: 'fixture-token', userId: ME }),
      hasCapability: () => true, sync: {} as never, identities: async () => [], faces: async () => ({}),
      filesUrl: () => 'http://files.invalid', warn: () => undefined })
    return { ...f, replace: () => files.replace({ pageId: 1, extensionId: 'workspace', itemId: ITEM },
      { ref: { id: ITEM }, expectedVersion: 1, file: { name: 'report.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('replacement').buffer } }) }
  }

  it.each(['Permission denied for file publication', 'Project file can only be updated by its host'])('preserves the real refusal: %s', async message => {
    const f = app(refusal(message))
    const caught = await f.replace().catch((error: unknown) => error)
    expect(bridgeFailure(caught)).toEqual({ code: 'failed', message: `report.pdf was not replaced: ${message}` })
    expect(f.network).toHaveBeenCalledOnce()
    expect(state.row.version).toBe(1)
    expect(await readFile(join(root, 'report.pdf'), 'utf8')).toBe('original')
  })

  it('keeps the existing content-changed result and current-version detail for a real revision conflict', async () => {
    const f = app({ ...refusal('File revision conflict'), code: 'P0001', hint: 'workspace_version_conflict' }, 2)
    const caught = await f.replace().catch((error: unknown) => error)
    expect(bridgeFailure(caught)).toMatchObject({ code: 'content-changed', detail: { reason: 'replaced-since', name: 'report.pdf', now: 2, expected: 1 } })
    expect(f.network).toHaveBeenCalledOnce()
    expect(await readFile(join(root, 'report.pdf'), 'utf8')).toBe('original')
  })
})
