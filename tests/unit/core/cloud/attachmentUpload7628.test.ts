import { describe, expect, it, vi } from 'vitest'
import { uploadAttachmentBytes } from '../../../../packages/core/src/cloud/attachmentsApi'

describe('attachment upload transports', () => {
  it('uses a raw PUT body for a Supabase signed upload', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024,
      })))
      .mockResolvedValueOnce(new Response('{}'))
    const key = await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1, 2, 3]), name: 'data.bin', contentType: 'application/octet-stream',
    })
    expect(key).toBe('staging/u/file')
    const upload = fetcher.mock.calls[1][1] as RequestInit
    expect(upload.method).toBe('PUT')
    expect(upload.body).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (upload.body as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(upload.headers).not.toHaveProperty('Authorization')
  })

  it('keeps the existing multipart POST contract when method is omitted', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        staging_key: 'staging/u/file', url: 'https://storage.example/form', fields: { policy: 'scoped' }, max_bytes: 1024,
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1]), name: 'data.bin', contentType: 'application/octet-stream',
    })
    const upload = fetcher.mock.calls[1][1] as RequestInit
    expect(upload.method).toBe('POST')
    expect((upload.body as FormData).get('policy')).toBe('scoped')
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob)
  })
})
