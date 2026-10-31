import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { cloudFileProviders, type FileChunkCache } from '../../../../packages/core/src/cloud/fileProviders'
import { createFileKey, transformFile, type FileSink } from '../../../../packages/core/src/shared/fileCipher'
import { createFileResolver, type FileBytes, type FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const plain = Buffer.alloc(700_001, 73), digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const revision: FileRevision = { source: 'managed-object', item_id: 'file', version: 2, chat_id: 'group', file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: plain.length, sha256: digest(plain) }
const context = { ref: { item_id: 'file' }, actor: { accountId: 'owner', actorId: 'agent' } }
function bytesFile(bytes: Uint8Array): FileBytes { return { size: bytes.length, read: async (offset, length) => new Uint8Array(bytes.subarray(offset, offset + length)), dispose: async () => {} } }
function sink(): FileSink {
  let chunks: Uint8Array[] = []
  return { write: async bytes => { expect(bytes.length).toBeLessThanOrEqual(524288); chunks.push(bytes.slice()) }, commit: async () => bytesFile(Buffer.concat(chunks)), abort: async () => { chunks = [] } }
}
function cache() {
  const chunks = new Map<string, Uint8Array>()
  const store: FileChunkCache = { get: vi.fn(async (key, index) => chunks.get(`${key}:${index}`) ?? null), put: vi.fn(async (key, index, bytes) => { chunks.set(`${key}:${index}`, bytes.slice()) }), clear: vi.fn(async key => { for (const entry of chunks.keys()) if (entry.startsWith(`${key}:`)) chunks.delete(entry) }) }
  return { chunks, store }
}
function api(row: Omit<FileRevision, 'sha256'> & { sha256: unknown; bucket_id?: string } = revision, body = new Uint8Array(plain), extra: Record<string, unknown> = {}) {
  const calls: { route: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = String(input).split('/').at(-1)!, request = JSON.parse(init!.body as string)
    calls.push({ route, body: request })
    if (route === 'file-resolve') return Response.json({ ...row, status: 'ready', url: 'must-not-escape' })
    if (route === 'file-request') return Response.json({ status: 'ready', transfer_status: 'ready' })
    if (route === 'file-read-complete') return Response.json({ acknowledged: true })
    if (route === 'file-download') return Response.json({ status: 'ready', url: 'https://objects.invalid/file', sha256: row.sha256, size_bytes: body.length, download_id: 'download', ...extra })
    throw Error(`Unexpected test route ${route}`)
  })
  const endpoint = async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'test-anon', token: 'test-token', fetch: fetcher as typeof fetch })
  return { calls, fetcher, endpoint }
}

describe('one cloud provider and verified raw chunk cache', () => {
  it('recognizes only the authenticated server missing status/code, preserving generic errors', async () => {
    const a = api(), c = cache(), cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink() })
    a.fetcher.mockResolvedValueOnce(Response.json({ status: 'missing', code: 'object_not_found' }))
    expect(await cloud.metadata(context)).toEqual({ status: 'missing', sha256: null })
    a.fetcher.mockResolvedValueOnce(Response.json({ status: 'missing', code: 'failed' }))
    await expect(cloud.metadata(context)).rejects.toThrow('Invalid file metadata')
    for (const status of [403, 500, 503]) {
      a.fetcher.mockResolvedValueOnce(Response.json({ error: 'failed' }, { status }))
      await expect(cloud.metadata(context)).rejects.toMatchObject({ status, code: 'failed' })
    }
  })
  it.each(['download', 'preview'])('retains an explicit missing signal received during %s after metadata was ready', async purpose => {
    const row = { ...revision, content_type: 'image/png' }, a = api(row), c = cache()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink() })
    a.fetcher.mockResolvedValue(Response.json({ status: 'missing', code: 'object_not_found' }))
    const read = purpose === 'download' ? cloud.managed(row, context) : cloud.preview!(row, context, vi.fn())
    await expect(read).rejects.toThrow('missing')
  })
  const legacyRef = { message_id: 'historical-message' }
  const legacyContext = { ...context, ref: legacyRef }
  const legacyRow = { ...revision, item_id: undefined, version: undefined, message_id: legacyRef.message_id,
    bucket_id: 'chat-media', object_name: 'old-account/portrait.png', content_type: 'image/png', sha256: null }

  it('opens and previews a backend-identified historical object without inventing a digest', async () => {
    const a = api(legacyRow, plain, legacyRow), c = cache()
    const fetcher = vi.fn(async () => new Response(plain))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: fetcher as typeof fetch })
    const resolve = createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })
    const file = await resolve(legacyRef, context.actor)
    if (file.status !== 'ready') throw Error('ready expected')
    expect(file.revision.sha256).toBeNull()
    expect(digest(Buffer.concat([await file.read(0, 524288), await file.read(524288, plain.length - 524288)]))).toBe(revision.sha256)
    await file.dispose()
    const preview = await resolve(legacyRef, context.actor, { purpose: 'preview' })
    if (preview.status !== 'ready') throw Error('ready expected')
    const blob = await preview.content() as Blob
    expect(digest(new Uint8Array(await blob.arrayBuffer()))).toBe(revision.sha256)
    await preview.dispose()
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const call of a.calls.filter(call => call.route === 'file-download')) expect(call.body.ref).toEqual(legacyRef)
  })

  it.each([
    { bucket_id: 'oss' }, { bucket_id: undefined }, { message_id: 'another-message' }, { object_name: '' },
  ])('rejects missing digests without an exact historical identity: %j', async override => {
    const a = api({ ...legacyRow, ...override }), c = cache()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink() })
    await expect(cloud.metadata(legacyContext)).rejects.toThrow('Invalid file revision')
  })

  it.each([null, undefined, '', 'not-a-sha'])('requires a valid digest for current uploads: %j', async sha256 => {
    const a = api({ ...revision, bucket_id: 'oss', sha256 }), c = cache()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink() })
    await expect(cloud.metadata(context)).rejects.toThrow('Invalid file revision')
  })

  it('still verifies a historical object when the backend supplies its digest', async () => {
    const row = { ...legacyRow, sha256: revision.sha256 }, a = api(row, plain, row), c = cache()
    const changed = new Uint8Array(plain); changed[0] ^= 1
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: async () => new Response(changed) })
    const file = await createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })(legacyRef, context.actor)
    if (file.status !== 'ready') throw Error('ready expected')
    await expect(file.read(0, 1)).rejects.toThrow('File SHA-256 mismatch'); await file.dispose()
  })

  it.each([{ bucket_id: 'oss' }, { object_name: 'different-object' }, { message_id: 'different-message' }])('rejects a changed historical download identity: %j', async override => {
    const a = api(legacyRow, plain, { ...legacyRow, ...override }), c = cache(), fetcher = vi.fn()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: fetcher })
    const file = await createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })(legacyRef, context.actor)
    if (file.status !== 'ready') throw Error('ready expected')
    await expect(file.read(0, 1)).rejects.toThrow('File download commitment changed')
    expect(fetcher).not.toHaveBeenCalled(); await file.dispose()
  })

  it('rejects truncated historical bytes and a revoked historical read', async () => {
    for (const revoke of [false, true]) {
      const a = api(legacyRow, plain, legacyRow), c = cache()
      const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(),
        fetch: async () => { if (revoke) a.fetcher.mockResolvedValue(Response.json({ status: 'gone' })); return new Response(revoke ? plain : plain.subarray(0, -1)) } })
      const file = await createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })(legacyRef, context.actor)
      if (file.status !== 'ready') throw Error('ready expected')
      await expect(file.read(0, 1)).rejects.toThrow(revoke ? 'File access or revision changed' : 'Truncated file response')
      await file.dispose()
    }
  })

  it('rejects a historical object replaced during the download even when its length stays equal', async () => {
    const a = api(legacyRow, plain, legacyRow), c = cache()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: async () => {
      a.fetcher.mockResolvedValue(Response.json({ ...legacyRow, status: 'ready', object_name: 'replacement-object' })); return new Response(plain)
    } })
    const file = await createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })(legacyRef, context.actor)
    if (file.status !== 'ready') throw Error('ready expected')
    await expect(file.read(0, 1)).rejects.toThrow('File access or revision changed'); await file.dispose()
  })

  it('keeps the object response HTTP status in the download failure reason', async () => {
    const a = api(), c = cache()
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(),
      fetch: vi.fn(async () => new Response('unavailable', { status: 503 })) as typeof fetch })
    await expect(cloud.managed(revision, context)).rejects.toThrow('HTTP 503')
  })
  it('uses and caches only the existing CDN thumbnail for managed previews; full downloads still verify the original', async () => {
    const thumbnail = 'https://objects.invalid/file?auth_key=lease&x-oss-process=image/resize,w_560/format,webp'
    const imageRevision = { ...revision, content_type: 'image/png' }
    const a = api(imageRevision, plain, { thumb_url: thumbnail }), c = cache(), images = new Map<string, Response>()
    const imageCache = { match: vi.fn(async key => images.get(String(key))?.clone()), put: vi.fn(async (key, value) => { images.set(String(key), value.clone()) }) } as Pick<Cache, 'match' | 'put'>
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === thumbnail ? new Response('small thumbnail', { headers: { 'content-type': 'image/webp' } }) : new Response(plain))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), imageCache, fetch: fetcher as typeof fetch })
    const resolve = createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })
    for (let i = 0; i < 2; i++) {
      const preview = await resolve(context.ref, context.actor, { purpose: 'preview' })
      if (preview.status !== 'ready') throw Error('ready expected')
      const content = await preview.content()
      expect(content).toBeInstanceOf(Blob); expect(await (content as Blob).text()).toBe('small thumbnail'); await preview.dispose()
    }
    expect(fetcher.mock.calls.map(row => row[0])).toEqual([thumbnail])
    expect(a.calls.filter(row => row.route === 'file-download')).toHaveLength(1)
    const full = await cloud.managed(revision, context)
    expect(digest(Buffer.concat([await full.read(0, 524288), await full.read(524288, plain.length - 524288)]))).toBe(revision.sha256)
    expect(fetcher.mock.calls.map(row => row[0])).toEqual([thumbnail, 'https://objects.invalid/file'])
    await full.dispose()
  })
  it.each(['image/svg+xml', 'image/png'])('uses the verified original when the signer provides no thumbnail for %s', async contentType => {
    const row = { ...revision, content_type: contentType }, a = api(row, plain, { thumb_url: null }), c = cache()
    const image = vi.fn(async () => { throw Error('Unexpected local image conversion') })
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(plain))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), image, fetch: fetcher as typeof fetch })
    const resolve = createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })
    const preview = await resolve(context.ref, context.actor, { purpose: 'preview' })
    if (preview.status !== 'ready') throw Error('ready expected')
    try {
      const blob = await preview.content() as Blob
      expect(blob.type).toBe(contentType)
      expect(digest(new Uint8Array(await blob.arrayBuffer()))).toBe(row.sha256)
      expect(fetcher.mock.calls.map(call => call[0])).toEqual(['https://objects.invalid/file'])
      expect(image).not.toHaveBeenCalled()
    } finally { await preview.dispose() }
  })
  it('a local preview opens the verified source first and never signs a CDN URL', async () => {
    const a = api(), c = cache(), file = bytesFile(plain), full = vi.fn(async () => file)
    const image = vi.fn(async (verified: FileBytes) => { expect(verified).toBe(file); return new Blob(['local pixels'], { type: 'image/webp' }) })
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), image })
    expect(await (await cloud.preview!({ ...revision, source: 'local', content_type: 'image/png' }, context, full) as Blob).text()).toBe('local pixels')
    expect(full).toHaveBeenCalledTimes(1); expect(image).toHaveBeenCalledTimes(1); expect(a.calls).toEqual([])
  })
  it('managed video leases stream by Range, expire after 60 seconds and renew through the same signer', async () => {
    let now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const c = cache(), row = { ...revision, content_type: 'video/mp4' }, calls: Record<string, unknown>[] = []
    const fetchObject = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Range: 'bytes=524288-' })
      const signed = new URL(String(_url)).searchParams.get('expires')
      return now >= Number(signed) ? new Response(null, { status: 403 }) : new Response(plain.subarray(524288), { status: 206 })
    })
    const endpoint = async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'anon', token: 'token', fetch: (async (url, init) => {
      if (String(url).endsWith('file-resolve')) return Response.json({ ...row, status: 'ready' })
      expect(String(url)).toMatch(/file-download$/)
      calls.push(JSON.parse(String(init?.body)))
      return Response.json({ status: 'ready', url: `https://objects.invalid/video?expires=${now + 60_000}`, expires_at: new Date(now + 60_000).toISOString(), sha256: row.sha256, size_bytes: row.size_bytes })
    }) as typeof fetch })
    const fullSink = vi.fn(async () => sink())
    try {
      const resolve = createFileResolver({ ...cloudFileProviders({ endpoint, cache: c.store, sink: fullSink, fetch: fetchObject as typeof fetch }), local: async () => null, ssh: async () => null })
      const preview = await resolve(context.ref, context.actor, { purpose: 'preview' })
      if (preview.status !== 'ready') throw Error('ready expected')
      const first = await preview.content()
      if (first instanceof Blob) throw Error('streaming lease expected')
      expect(first.expiresAt - now).toBe(60_000)
      expect(fetchObject).not.toHaveBeenCalled(); expect(fullSink).not.toHaveBeenCalled(); expect(c.chunks.size).toBe(0)
      now += 60_001
      expect((await fetchObject(first.url, { headers: { Range: 'bytes=524288-' } })).status).toBe(403)
      const next = await preview.content()
      if (next instanceof Blob) throw Error('streaming lease expected')
      expect(next.url).not.toBe(first.url); expect(next.expiresAt - now).toBe(60_000)
      expect((await fetchObject(next.url, { headers: { Range: 'bytes=524288-' } })).status).toBe(206)
      expect(calls).toHaveLength(2); expect(calls[0]!.request_id).not.toBe(calls[1]!.request_id)
      for (const call of calls) expect(call).toMatchObject({ as: 'agent', ref: { item_id: 'file', version: 2 } })
      expect(fullSink).not.toHaveBeenCalled(); await preview.dispose()
    } finally { clock.mockRestore() }
  })
  it('a project video fully opens its verified/decrypted snapshot before exposing local playback', async () => {
    const c = cache(), a = api(), opened = vi.fn(async () => bytesFile(plain))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink() })
    const video = await cloud.preview!({ ...revision, source: 'local', content_type: 'video/mp4' }, context, opened)
    expect(video).toBeInstanceOf(Blob); expect((video as Blob).type).toBe('video/mp4')
    expect(digest(new Uint8Array(await (video as Blob).arrayBuffer()))).toBe(revision.sha256)
    expect(opened).toHaveBeenCalledTimes(1); expect(a.calls).toEqual([])
    await expect(cloud.preview!({ ...revision, source: 'local', content_type: 'video/mp4' }, context, async () => { throw Error('SHA mismatch') })).rejects.toThrow('SHA mismatch')
  })
  it('an empty managed file still performs an authenticated GET before publishing its empty snapshot', async () => {
    const row = { ...revision, size_bytes: 0, sha256: digest(new Uint8Array()) }, a = api(row, new Uint8Array()), c = cache(), fetcher = vi.fn(async () => new Response(new Uint8Array()))
    const file = await cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: fetcher as typeof fetch }).managed(row, context)
    expect(file.size).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1); await file.dispose()
  })
  it('metadata does not sign or read, strips provider details, and the first read uses one lease and GET', async () => {
    const a = api(), c = cache(), fetcher = vi.fn(async () => new Response(plain))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: fetcher as typeof fetch })
    const file = await createFileResolver({ ...cloud, local: async () => null, ssh: async () => null })(context.ref, context.actor)
    expect(a.calls.map(row => row.route)).toEqual(['file-resolve']); expect(fetcher).not.toHaveBeenCalled()
    if (file.status !== 'ready') throw Error('ready expected')
    expect('url' in file.revision).toBe(false)
    expect(await file.read(0, 4)).toEqual(new Uint8Array([73, 73, 73, 73]))
    expect(a.calls.map(row => row.route)).toEqual(['file-resolve', 'file-download', 'file-resolve'])
    expect(a.calls[1]!.body).toMatchObject({ ref: { item_id: 'file', version: 2 }, as: 'agent' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await file.dispose()
    const hit = await cloud.managed(revision, context)
    expect(await hit.read(0, 1)).toEqual(new Uint8Array([73])); await hit.dispose()
    expect(a.calls.filter(row => row.route === 'file-download')).toHaveLength(1)
  })
  it('resumes a real interrupted HTTP GET from the persisted prefix without fetching that prefix again', async () => {
    const c = cache(), requests: (string | undefined)[] = []
    let firstResponse: ServerResponse | undefined
    const server = createServer((request, response) => {
      requests.push(request.headers.range)
      if (!request.headers.range) { firstResponse = response; response.writeHead(200, { 'content-length': plain.length }); response.write(plain.subarray(0, 524288)); return }
      expect(request.headers.range).toBe('bytes=524288-')
      response.writeHead(206, { 'content-range': `bytes 524288-${plain.length - 1}/${plain.length}`, 'content-length': plain.length - 524288 })
      response.end(plain.subarray(524288))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('HTTP fixture missing')
    const a = api(revision, plain, { url: `http://127.0.0.1:${address.port}/file` })
    const originalPut = c.store.put
    c.store.put = async (key, index, bytes) => { await originalPut(key, index, bytes); if (index === 0) firstResponse?.destroy() }
    const deps = { endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch }
    try {
      await expect(cloudFileProviders(deps).managed(revision, context)).rejects.toThrow()
      expect(c.chunks.size).toBe(1); expect(c.store.clear).not.toHaveBeenCalled()
      const resumed = await cloudFileProviders(deps).managed(revision, context) // New provider instance, same raw cache.
      const chunks = [await resumed.read(0, 524288), await resumed.read(524288, plain.length - 524288)]
      expect(digest(Buffer.concat(chunks))).toBe(revision.sha256)
      expect(requests).toEqual([undefined, 'bytes=524288-'])
      expect(a.calls.filter(row => row.route === 'file-download')).toHaveLength(2)
      await resumed.dispose()
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it.each(['short', 'extra', 'sha', 'range'])('rejects %s bytes without exposing a snapshot and clears the raw cache', async bad => {
    const c = cache(), a = api()
    if (bad === 'range') await c.store.put('unrelated', 0, new Uint8Array([1]))
    const bytes = bad === 'short' ? plain.subarray(0, -1) : bad === 'extra' ? Buffer.concat([plain, Buffer.from([0])]) : bad === 'sha' ? Buffer.alloc(plain.length, 1) : plain
    const committed = vi.fn(async () => bytesFile(new Uint8Array()))
    const fetcher = vi.fn(async () => new Response(bytes, { status: bad === 'range' ? 206 : 200 }))
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, fetch: fetcher as typeof fetch, sink: async () => ({ write: async () => {}, commit: committed, abort: async () => {} }) })
    await expect(cloud.managed(revision, context)).rejects.toThrow()
    expect(committed).not.toHaveBeenCalled(); expect(c.store.clear).toHaveBeenCalledTimes(1)
  })
  it('authenticates a client-encrypted generation, transfers the key only over the API and ACKs after verification', async () => {
    const local = { ...revision, source: 'local' as const, host_account_id: 'host', host_device_id: 'device', host_project_id: 'project', relative_path: 'file.bin', temporary_transfer: true }
    const key = await createFileKey(), encoded = await transformFile({ direction: 'encrypt', revision: local, source: bytesFile(plain), sink: sink(), key })
    const cipher = Buffer.concat([await encoded.file.read(0, 524288), await encoded.file.read(524288, encoded.file.size - 524288)])
    const a = api(local, cipher, { codec: 'secretstream-v1', key: Buffer.from(key).toString('base64'), ciphertext_bytes: cipher.length, ciphertext_sha256: digest(cipher) }), c = cache()
    const objectFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(init?.headers).toEqual({}); return new Response(cipher) })
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: c.store, sink: async () => sink(), fetch: objectFetch as typeof fetch })
    const decoded = await cloud.temporary(local, context)
    expect(digest(Buffer.concat([await decoded.read(0, 524288), await decoded.read(524288, plain.length - 524288)]))).toBe(revision.sha256)
    expect(a.calls.map(row => row.route)).toEqual(['file-request', 'file-download', 'file-resolve', 'file-read-complete'])
    expect(JSON.stringify(a.calls)).not.toContain(Buffer.from(key).toString('base64'))
    expect(objectFetch).toHaveBeenCalledTimes(1)
    await decoded.dispose(); key.fill(0)
  })
  // A project chat has no host: only the device that keeps a version can send it. While it is offline the reader is told
  // which machine, at once, instead of waiting for a copy that cannot come.
  it('says the keeping machine is offline when no copy of its version is in the cloud yet', async () => {
    const local = { ...revision, source: 'local' as const, host_account_id: 'host', host_device_id: 'device', host_project_id: 'project', relative_path: 'file.bin', temporary_transfer: true }
    const a = api(local), objectFetch = vi.fn()
    a.fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      a.calls.push({ route: String(input).split('/').at(-1)!, body: JSON.parse(init!.body as string) })
      return Response.json({ status: 'ready', transfer_status: 'requested', host_label: 'Studio Mac', host_online: false })
    })
    const cloud = cloudFileProviders({ endpoint: a.endpoint, cache: cache().store, sink: async () => sink(), fetch: objectFetch as typeof fetch })
    await expect(cloud.temporary(local, context)).rejects.toThrow('Studio Mac is offline. This file opens when it is back online.')
    expect(a.calls.map(row => row.route)).toEqual(['file-request'])
    expect(objectFetch).not.toHaveBeenCalled()
  })
  it('refuses a download denied after metadata without touching the object provider', async () => {
    const a = api(), c = cache(), fetcher = vi.fn()
    const cloud = cloudFileProviders({ endpoint: async () => ({ ...await a.endpoint(), fetch: async () => Response.json({ error: 'denied', message: 'Denied' }, { status: 403 }) }), cache: c.store, sink: async () => sink(), fetch: fetcher })
    await expect(cloud.managed(revision, context)).rejects.toThrow('Denied')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
