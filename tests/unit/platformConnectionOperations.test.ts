import { describe,expect,it,vi } from 'vitest'
import { createPlatformIntegrationsClient } from '../../packages/core/src/cloud/platformIntegrations'
const operationId = '6c67af58-7190-4c6f-9d49-06d0f6f4865f',admissionId = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
const receipt = { operationId,admissionId,scopeKey: 'platform',resourceKey: 'original-key',revision: '8',status: 'applied',errorCode: null,terminal: false }
function setup(value: unknown = receipt) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(value),{ status: 200 }))
  const client = createPlatformIntegrationsClient({ baseUrl: 'https://fixture.invalid/cloud',accessToken: async () => 'fixture-jwt',fetch })
  return { fetch,revoke: () => client.disconnectOperation!('provider',operationId,'7') }
}
describe('platform owner revocation transport', () => {
  it('uses the owner JWT and only the original UUID/head, without a device or credential id', async () => {
    const { fetch,revoke } = setup()
    expect(await revoke()).toEqual(receipt)
    const [url,options] = fetch.mock.calls[0]!
    expect(url).toBe('https://fixture.invalid/cloud/integrations/provider/disconnect-operation')
    expect(options?.method).toBe('POST')
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-jwt' })
    expect(JSON.parse(String(options?.body))).toEqual({ operationId,expectedHeadRevision: '7' })
  })
  it('resends the same operation after a lost response and never calls naked DELETE', async () => {
    const { fetch,revoke } = setup()
    fetch.mockRejectedValueOnce(new Error('RESPONSE_LOST'))
    await expect(revoke()).rejects.toThrow()
    await revoke()
    expect(fetch.mock.calls.map(([url,options]) => [url,options?.method,options?.body])).toEqual([
      ['https://fixture.invalid/cloud/integrations/provider/disconnect-operation','POST',JSON.stringify({ operationId,expectedHeadRevision: '7' })],
      ['https://fixture.invalid/cloud/integrations/provider/disconnect-operation','POST',JSON.stringify({ operationId,expectedHeadRevision: '7' })],
    ])
  })
  it('rejects a receipt for a different operation or device scope', async () => {
    await expect(setup({ ...receipt,operationId: admissionId }).revoke()).rejects.toMatchObject({ code: 'invalid-response' })
    await expect(setup({ ...receipt,scopeKey: 'device:device' }).revoke()).rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('surfaces platform service failure without selecting another executor', async () => {
    const { fetch,revoke } = setup()
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unavailable' }),{ status: 503 }))
    await expect(revoke()).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
