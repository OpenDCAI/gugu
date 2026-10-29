import { describe, expect, it, vi } from 'vitest'
import { uploadAttachmentBytes } from '../../../../packages/core/src/cloud/attachmentsApi'

describe('attachment upload transports', () => {
  it.each([{ retry: false, request_id: 'reservation' }, { retry: true, request_id: undefined }])('does not accept a storage conflict without a retry of the same reservation (%j)', async options => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024,
    }))).mockResolvedValueOnce(new Response(null, { status: 409 }))
    await expect(uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'chat', as: 'sender', request_id: options.request_id }, { retry: options.retry })).rejects.toThrow('409')
  })
  it('reports the signed expiry before transferring bytes and preserves the reservation ID', async () => {
    const plan = { staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024, expires_at: '2030-01-01T01:00:00Z' }
    const onPlan = vi.fn()
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/upload')) {
        expect(JSON.parse(init.body as string).request_id).toBe('reservation-id')
        return new Response(JSON.stringify(plan))
      }
      expect(onPlan).toHaveBeenCalledExactlyOnceWith(plan)
      return new Response(null, { status: 204 })
    })
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher as typeof fetch }, {
      bytes: new Uint8Array([1]), name: 'file.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'chat', as: 'sender', request_id: 'reservation-id' }, { onPlan })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('uses a raw PUT body for a Supabase signed upload', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024,
      })))
      .mockResolvedValueOnce(new Response('{}'))
    const key = await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1, 2, 3]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'source-chat', as: 'sender-agent', request_id: '12345678-1234-4234-8234-123456789abc' })
    expect(key).toBe('staging/u/file')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      size_bytes: 3, content_type: 'application/octet-stream', chat_id: 'source-chat', as: 'sender-agent', request_id: '12345678-1234-4234-8234-123456789abc',
    })
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
      bytes: new Blob([new Uint8Array([1])]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: null, as: 'private-sender' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      size_bytes: 1, content_type: 'application/octet-stream', chat_id: null, as: 'private-sender', request_id: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
    })
    const upload = fetcher.mock.calls[1][1] as RequestInit
    expect(upload.method).toBe('POST')
    expect((upload.body as FormData).get('policy')).toBe('scoped')
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob)
  })

  it('declares the content type, so a project chat that keeps files local can admit an image', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ staging_key: 'staging/u/img', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024 })))
      .mockResolvedValueOnce(new Response('{}'))
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([137, 80, 78, 71]), name: 'image.png', contentType: 'image/png',
    }, { chat_id: 'project-chat', as: 'member' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ content_type: 'image/png', chat_id: 'project-chat' })
  })
})
