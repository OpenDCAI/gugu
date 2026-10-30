import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileResolver, type FileProviders, type FileRevision } from '../../../../packages/core/src/shared/fileResolver'
import { ciphertextSize, transformFile } from '../../../../packages/core/src/shared/fileCipher'
import { createProjectTransferHost } from '../../../../apps/desktop/electron/projectFileTransferHost'
import { createFileChunkCache, createFileSink } from '../../../../apps/desktop/electron/fileSnapshot'
import { createProjectFileReader, localProjectFileProvider, openProjectFileSource, snapshotProjectFile } from '../../../../apps/desktop/electron/projectFileHost'
import { ownSshFileProvider } from '../../../../apps/desktop/electron/projectFileSsh'
import { createDesktopFileAccess } from '../../../../apps/desktop/electron/desktopFileAccess'
import { deviceFile, writeDeviceIdCache } from '@gugu/core/cloud/deviceRuntime'
import { forgetProjectFile, forgetProjectGroupId, readProjectFile, rememberProjectFile, rememberProjectGroupId } from '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'

let home: string, root: string, tempRoot: string, env: NodeJS.ProcessEnv
let accountId: string, revision: FileRevision
const bytes = Buffer.alloc(700_001, 83)
const ref = { item_id: 'item', version: 1 }
const actor = { accountId: 'owner', actorId: 'owner' }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const identity = async () => ({ accountId, deviceId: 'host-device' })
const reader = () => createProjectFileReader({ identity, root: async id => id === 'project' ? root : null, env })
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-project-file-access-'))
  root = join(home, 'project'); tempRoot = join(home, 'snapshots')
  env = { GUGU_HOME: home }; accountId = 'owner'
  await mkdir(root); await writeFile(join(root, 'file.bin'), bytes)
  revision = { source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: digest(bytes), host_account_id: 'owner', host_device_id: 'host-device', host_project_id: 'project', relative_path: 'file.bin' }
  await rememberProjectGroupId('project', 'group', 'owner', env)
  await rememberProjectFile(revision, 'owner', env)
})
afterEach(async () => {
  const path = home
  console.log('Removing own project file fixture:', path)
  if (!path.startsWith(join(tmpdir(), 'gugu-project-file-access-'))) throw Error('Unexpected fixture path')
  await rm(path, { recursive: true, force: true })
})

describe('account/project revision index', () => {
  it('stores no absolute root and partitions account, device, version and binding', async () => {
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toEqual(revision)
    for (const [owner, device, version] of [['other', 'host-device', 1], ['owner', 'other-device', 1], ['owner', 'host-device', 2]] as const) {
      expect(await readProjectFile({ ...ref, version }, owner, device, env)).toBeNull()
    }
    const mapping = await readFile(join(home, 'taskpage-project-groups.json'), 'utf8')
    expect(mapping).not.toContain(root)
    await rememberProjectGroupId('project', 'other-group', 'owner', env)
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toBeNull()
  })
  it('serializes concurrent index writes with group writes, and forget invalidates', async () => {
    await Promise.all(Array.from({ length: 4 }, (_, n) => rememberProjectFile({ ...revision, item_id: `item-${n}` }, 'owner', env)))
    for (let n = 0; n < 4; n++) expect(await readProjectFile({ item_id: `item-${n}` }, 'owner', 'host-device', env)).not.toBeNull()
    await forgetProjectFile('item-0', 'owner', env)
    expect(await readProjectFile({ item_id: 'item-0' }, 'owner', 'host-device', env)).toBeNull()
    await forgetProjectGroupId('project', 'owner', env)
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toBeNull()
  })
  it.each(['../secret', '/absolute', 'file/../secret', 'C:\\secret', 'a\u0000b'])('rejects unsafe path %j at publication and cache read', async relative_path => {
    await expect(rememberProjectFile({ ...revision, relative_path }, 'owner', env)).rejects.toThrow()
    const path = join(home, 'taskpage-project-groups.json')
    const mapping = JSON.parse(await readFile(path, 'utf8'))
    mapping.files.owner.item.relative_path = relative_path
    await writeFile(path, JSON.stringify(mapping))
    await expect(readProjectFile(ref, 'owner', 'host-device', env)).rejects.toThrow('Invalid local file revision')
  })
  it('does not admit an unbound or foreign-owner revision', async () => {
    await expect(rememberProjectFile({ ...revision, host_account_id: 'other' }, 'owner', env)).rejects.toThrow()
    await expect(rememberProjectFile({ ...revision, chat_id: 'other' }, 'owner', env)).rejects.toThrow('binding changed')
    await expect(rememberProjectFile({ ...revision, chat_id: undefined }, 'owner', env)).rejects.toThrow()
  })
})

describe('a later version the database made from the same bytes (#719: a rename or move)', () => {
  // The index still holds version 1; the database's record of version 2 names the same bytes under a new name.
  const renamed = () => ({ ...revision, version: 2, file_name: 'renamed.bin' })
  it('reads version 2 as the same bytes, under its new name, and keeps reading version 1 without asking', async () => {
    const later = vi.fn(async () => renamed())
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, later)).toEqual({ ...revision, version: 2, file_name: 'renamed.bin' })
    expect(later).toHaveBeenCalledWith({ item_id: 'item', version: 2 })
    later.mockClear()
    expect(await readProjectFile(ref, 'owner', 'host-device', env, later)).toEqual(revision)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'host-device', env, later)).toEqual(revision)
    expect(later).not.toHaveBeenCalled()
    const provider = localProjectFileProvider({ identity, read: createProjectFileReader({ identity, root: async () => root, env, later }), tempRoot, env, later })
    const file = await createFileResolver({ local: provider, metadata: later as never, managed: later as never, ssh: later as never, temporary: later as never })({ ...ref, version: 2 }, actor)
    if (file.status !== 'ready') throw Error('ready expected')
    expect(file.revision).toMatchObject({ version: 2, file_name: 'renamed.bin' })
    expect(await file.read(500_000, 2)).toEqual(new Uint8Array([83, 83]))
    await file.dispose()
  })
  it('the composition root asks the database for that version as the owner', async () => {
    await writeDeviceIdCache(deviceFile(env, 'owner'), 'host-device')
    const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/functions\/v1\/attachments\/file-resolve$/)
      expect(JSON.parse(String(init?.body))).toEqual({ ref: { item_id: 'item', version: 2 }, as: 'owner' })
      return Response.json({ ...renamed(), status: 'ready' })
    })
    const access = createDesktopFileAccess({ auth: async () => ({ userId: 'owner', accessToken: 'memory-only-token' }), root: async () => root, links: () => null, tempRoot, downloads: join(home, 'downloads'), fetch: network as typeof fetch, rpc: network as never, env, deviceStore: join(home, 'project-files'), identityDb: network as never })
    const file = await access.resolveAccount({ id: 'item' }, null, { version: 2, localOnly: true })
    if (file?.status !== 'ready') throw Error('ready expected')
    expect(file.revision.file_name).toBe('renamed.bin')
    expect(await file.read(0, 2)).toEqual(new Uint8Array([83, 83]))
    await file.dispose()
  })
  it.each([
    ['another path', { relative_path: 'other.bin' }], ['other bytes', { sha256: 'ab'.repeat(32) }], ['another size', { size_bytes: 7 }],
    ['another computer', { host_device_id: 'other-device' }], ['another project', { host_project_id: 'other' }], ['another chat', { chat_id: 'other' }],
    ['another version', { version: 3 }], ['bytes in the cloud', { source: 'managed-object' }],
  ] as const)('refuses when the database names %s', async (_, change) => {
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, async () => ({ ...renamed(), ...change }) as FileRevision)).toBeNull()
  })
  it('refuses a version the database does not have, and never asks about one older than the index', async () => {
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, async () => null)).toBeNull()
    await rememberProjectFile({ ...revision, version: 3 }, 'owner', env)
    const later = vi.fn(async () => renamed())
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, later)).toBeNull()
    expect(later).not.toHaveBeenCalled()
  })
})

describe('local read fence and verified snapshot', () => {
  it('the production composition root opens by item or folder path without cloud, auth refresh or an SSH dial', async () => {
    await writeDeviceIdCache(deviceFile(env, 'owner'), 'host-device')
    await rememberProjectFile({ ...revision, workspace: { path: 'file.bin', parent_id: null, created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', created_by: 'owner', source_message_ids: [] } }, 'owner', env)
    const network = vi.fn(async () => { throw new Error('Unexpected network request') })
    const links = vi.fn(() => null)
    const access = createDesktopFileAccess({ auth: async () => ({ userId: accountId, accessToken: 'memory-only-token' }), root: async () => root, links, tempRoot, downloads: join(home, 'downloads'), fetch: network, rpc: network, env, deviceStore: join(home, 'project-files'), identityDb: network as never })
    expect(access.handlers('realtime')).toEqual({})
    expect(Object.keys(access.handlers('ssh'))).toEqual(['file.read'])
    for (const named of [{ id: 'item' }, { chat: 'group', name: 'file.bin' }]) {
      const file = await access.resolveAccount(named, null, { localOnly: true })
      expect(file?.status).toBe('ready')
      if (file?.status !== 'ready') throw new Error('Expected local file')
      expect(file.revision.workspace?.path).toBe('file.bin')
      expect(await file.read(500_000, 2)).toEqual(new Uint8Array([83, 83]))
      await file.dispose()
    }
    expect(network).not.toHaveBeenCalled(); expect(links).not.toHaveBeenCalled()
    accountId = 'other'
    await expect(access.resolveAccount({ id: 'item' }, null, { localOnly: true })).rejects.toThrow('device.json missing')
    expect(network).not.toHaveBeenCalled()
  })
  it('persists only bounded raw chunks in the existing private cache across provider restarts', async () => {
    const key = 'ab'.repeat(32), first = createFileChunkCache(tempRoot)
    expect(await first.get(key, 0)).toBeNull()
    await first.put(key, 0, new Uint8Array([1, 2, 3]))
    const second = createFileChunkCache(tempRoot)
    expect(await second.get(key, 0)).toEqual(new Uint8Array([1, 2, 3]))
    expect((await stat(join(tempRoot, `open-${key}`))).mode & 0o777).toBe(0o700)
    expect((await stat(join(tempRoot, `open-${key}`, '0'))).mode & 0o777).toBe(0o600)
    for (const [badKey, index] of [['../project/file.bin', 0], [key, -1], [key, 0.5]] as const) {
      await expect(second.get(badKey, index)).rejects.toThrow('Invalid file cache key')
      await expect(second.put(badKey, index, new Uint8Array([7]))).rejects.toThrow('Invalid file cache key')
    }
    await expect(second.put(key, 1, new Uint8Array(524_289))).rejects.toThrow('Invalid file range')
    await writeFile(join(tempRoot, `open-${key}`, '1'), new Uint8Array(524_289))
    await expect(second.get(key, 1)).rejects.toThrow('Invalid file range')
    await second.clear(key); expect(await readdir(tempRoot)).toEqual([])
  })
  it('resolves locally before cloud lookup, is lazy, and exposes immutable bytes without paths or writes', async () => {
    const read = vi.fn(reader())
    const never = vi.fn(async () => { throw Error('Network must remain unused') })
    const providers: FileProviders = { local: localProjectFileProvider({ identity, read, tempRoot, env }), metadata: never, managed: never, ssh: never, temporary: never }
    const file = await createFileResolver(providers)(ref, actor)
    expect(file.status).toBe('ready'); expect(read).not.toHaveBeenCalled(); expect(never).not.toHaveBeenCalled()
    if (file.status !== 'ready') throw Error('ready expected')
    expect(await file.read(500_000, 100)).toEqual(new Uint8Array(bytes.subarray(500_000, 500_100)))
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 0))
    const all: Uint8Array[] = []
    for await (const chunk of file.stream()) all.push(chunk)
    expect(digest(Buffer.concat(all))).toBe(revision.sha256)
    expect('path' in file).toBe(false); expect('write' in file).toBe(false); expect(never).not.toHaveBeenCalled()
    await file.dispose()
    expect(await readdir(tempRoot)).toEqual([])
  })
  it('requires cloud ACL for an agent rather than borrowing the person’s local permission', async () => {
    const provider = localProjectFileProvider({ identity, read: reader(), tempRoot, env })
    expect(await provider({ ref, actor: { ...actor, actorId: 'agent' } })).toBeNull()
    accountId = 'other'
    expect(await provider({ ref, actor })).toBeNull()
  })
  it.each([[-1, 1], [0.5, 1], [0, 524_289], [700_001, 1]])('rejects rather than clamps invalid range %j/%j', async (offset, length) => {
    await expect(reader()({ ref, offset, length }, 'owner')).rejects.toThrow('Invalid file range')
  })
  it('rejects a caller-selected path, another identity and a symlink escaping the bound root', async () => {
    await expect(reader()({ ref, offset: 0, length: 0, path: '../secret' } as never, 'owner')).rejects.toThrow('Invalid file read request')
    await expect(reader()({ ref, offset: 0, length: 1 }, 'other')).rejects.toThrow('device owner')
    await writeFile(join(home, 'outside'), bytes)
    await rm(join(root, 'file.bin')); await symlink(join(home, 'outside'), join(root, 'file.bin'))
    await expect(reader()({ ref, offset: 0, length: 1 }, 'owner')).rejects.toThrow('outside this workspace')
  })
  it('rejects same-size SHA changes before exposing a snapshot and removes staging', async () => {
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(snapshotProjectFile(revision, request => reader()(request, 'owner'), tempRoot)).rejects.toThrow('SHA-256 mismatch')
    expect(await readdir(tempRoot)).toEqual([])
  })
  it('anchors current metadata, then detects modification, unbinding and account changes', async () => {
    const source = await openProjectFileSource(revision, request => reader()(request, 'owner'))
    expect(await source.read(0, 1)).toEqual(new Uint8Array([83]))
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(source.read(1, 1)).rejects.toThrow('changed during read')
    await forgetProjectGroupId('project', 'owner', env)
    await expect(reader()({ ref, offset: 0, length: 0 }, 'owner')).rejects.toThrow('unavailable')
    accountId = 'other'
    await expect(reader()({ ref, offset: 0, length: 0 }, 'owner')).rejects.toThrow('device owner')
  })
  it('creates private bounded staging, does not publish partial data, and cleans cancellation', async () => {
    const sink = await createFileSink(tempRoot, 2)
    await sink.write(new Uint8Array([1]))
    await expect(sink.commit()).rejects.toThrow('Incomplete')
    await expect(sink.blob()).rejects.toThrow('not committed')
    await expect(sink.write(new Uint8Array([1, 2]))).rejects.toThrow('Invalid')
    const [dir] = await readdir(tempRoot)
    expect((await stat(join(tempRoot, dir!))).mode & 0o777).toBe(0o700)
    await sink.abort(); expect(await readdir(tempRoot)).toEqual([])
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(snapshotProjectFile(revision, request => reader()(request, 'owner'), tempRoot, signal)).rejects.toThrow('cancelled')
    expect(await readdir(tempRoot)).toEqual([])
  })
})

describe('the owner’s already-held SSH link', () => {
  it('uses the real requester envelope and host read core, without opening or closing the window connection', async () => {
    let tap: { onMessage(message: unknown): void; onClosed(reason: string): void } | undefined
    const untap = vi.fn(), open = vi.fn(), close = vi.fn()
    const links = { ownedOpen: vi.fn(async () => true), open, close, tap: vi.fn((_device: string, handlers: typeof tap) => { tap = handlers; return untap }), send: vi.fn((_device: string, message: unknown) => {
      const envelope = (message as { payload: { request_id: string; user_id: string; payload: Parameters<ReturnType<typeof createProjectFileReader>>[0] } }).payload
      void reader()(envelope.payload, envelope.user_id).then(result => tap!.onMessage({ payload: { type: 'file.read:reply', request_id: envelope.request_id, result } }))
      return true
    }) }
    const file = await ownSshFileProvider(links, tempRoot)(revision, { ref, actor })
    expect(file).not.toBeNull()
    expect(await file!.read(0, 4)).toEqual(new Uint8Array([83, 83, 83, 83]))
    expect(links.send).toHaveBeenCalledTimes(3) // One metadata anchor, two bounded source reads.
    expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(untap).toHaveBeenCalledTimes(1)
    await file!.dispose()
  })
  it.each(['absent', 'other-account', 'agent'])('does not attach when %s', async kind => {
    const links = { ownedOpen: vi.fn(async () => kind !== 'absent'), tap: vi.fn(), send: vi.fn() }
    const who = kind === 'other-account' ? { accountId: 'other', actorId: 'other' } : kind === 'agent' ? { ...actor, actorId: 'agent' } : actor
    expect(await ownSshFileProvider(links, tempRoot)(revision, { ref, actor: who })).toBeNull()
    expect(links.tap).not.toHaveBeenCalled(); expect(links.send).not.toHaveBeenCalled()
  })
})

describe('the host’s on-demand client-encrypted transfer', () => {
  function fixture(options: { denied?: boolean; changed?: boolean } = {}) {
    const calls: string[] = [], commitBodies: Record<string, unknown>[] = []
    let uploaded: Uint8Array | undefined
    const read = vi.fn(async (request: Parameters<ReturnType<typeof createProjectFileReader>>[0]) => reader()(request, 'owner'))
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = String(input).split('/').at(-1)!
      calls.push(route)
      const body = route === 'object' ? null : JSON.parse(init!.body as string)
      if (route === 'file-pending') return Response.json({ transfers: [{ ...revision, id: 'transfer', state: 'requested', ...(options.changed ? { sha256: '0'.repeat(64) } : {}) }] })
      if (route === 'file-accept') {
        if (options.denied) return Response.json({ error: 'quota', message: 'Quota exhausted' }, { status: 403 })
        expect(body.ciphertext_bytes).toBe(ciphertextSize(bytes.length))
        expect(read).not.toHaveBeenCalled()
        return Response.json({ url: 'https://objects.invalid/object', fields: { key: 'random-object' }, max_bytes: ciphertextSize(bytes.length) })
      }
      if (route === 'object') {
        const form = init!.body as FormData
        expect([...form.keys()]).toEqual(['key', 'file'])
        uploaded = new Uint8Array(await (form.get('file') as Blob).arrayBuffer())
        expect(Buffer.from(uploaded)).not.toEqual(bytes)
        expect(uploaded.length).toBe(ciphertextSize(bytes.length))
        return new Response(null, { status: 204 })
      }
      if (route === 'file-commit') {
        expect(body.ciphertext_sha256).toBe(digest(uploaded!))
        expect(Buffer.from(body.key, 'base64').length).toBe(32)
        commitBodies.push(body)
        return Response.json({ status: 'ready' })
      }
      throw Error(`Unexpected fake route ${route}`)
    })
    const drain = createProjectTransferHost({ identity, read, tempRoot, env, endpoint: async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'test-anon', token: 'test-token', fetch: fetcher as typeof fetch }) })
    return { drain, calls, read, commitBodies, uploaded: () => uploaded }
  }
  it('reserves before disk/bytes, uses one upload executor, transfers the key only in commit and removes staging', async () => {
    const f = fixture()
    await Promise.all([f.drain(), f.drain()])
    expect(f.calls).toEqual(['file-pending', 'file-accept', 'object', 'file-commit'])
    expect(await readdir(tempRoot)).toEqual([])
    const cipher = f.uploaded()!
    const source = { size: cipher.length, dispose: async () => {}, read: async (offset: number, length: number) => cipher.slice(offset, offset + length) }
    const key = Buffer.from(f.commitBodies[0]!.key as string, 'base64')
    const decoded = await transformFile({ direction: 'decrypt', revision, source, key, ciphertextSha256: digest(cipher), sink: await createFileSink(tempRoot, bytes.length) })
    expect(digest(new Uint8Array(await (async () => {
      const chunks = []
      for (let offset = 0; offset < bytes.length; offset += 524288) chunks.push(await decoded.file.read(offset, Math.min(524288, bytes.length - offset)))
      return Buffer.concat(chunks)
    })()))).toBe(revision.sha256)
    await decoded.file.dispose(); key.fill(0)
    await f.drain() // A repeated event does not generate another key or overwrite an accepted object.
    expect(f.calls.filter(value => value === 'object')).toHaveLength(1)
  })
  it.each(['quota', 'revision', 'source-sha'])('does not upload or commit when %s fails', async failure => {
    const f = fixture({ denied: failure === 'quota', changed: failure === 'revision' })
    if (failure === 'source-sha') await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(f.drain()).rejects.toThrow('project file transfer(s) failed')
    expect(f.calls).not.toContain('object'); expect(f.calls).not.toContain('file-commit')
    if (failure !== 'source-sha') expect(f.read).not.toHaveBeenCalled()
    expect(await readdir(tempRoot).catch(() => [])).toEqual([])
  })
})
