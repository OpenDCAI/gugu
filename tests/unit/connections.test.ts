import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createConnectionClient, parseConnectionSnapshot, type ConnectionItem } from '../../packages/core/src/cloud/connections'

const operationId = '6c67af58-7190-4c6f-9d49-06d0f6f4865f'
const admissionId = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
const hash = 'a'.repeat(64)
const item = (): ConnectionItem => ({ scopeKey: 'device:device', resourceKey: 'original-key', deviceId: 'device', revision: '4',
  data: { providerId: 'github', accountId: 'account', configured: true }, publicMetadata: { login: 'person' },
  document: null, bodySha256: null, deletedAt: null, staleAt: null, observedAt: null, updatedAt: '2026-11-06T00:00:00Z' })
const snapshot = () => ({ version: 1, state: 'ready', revision: '4', items: [item()], application: [] })
function setup(value: unknown) {
  let owner: string | null = 'owner'
  const transport = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: value, error: null }))
  return { client: createConnectionClient(transport, () => owner), transport, account(next: string | null) { owner = next } }
}

describe('owner connection RPC wire contract', () => {
  it('reads explicit authority without owner/assistant arguments and rejects inferred or inconsistent modes', async () => {
    const value = { version: 1,mode: 'legacy',epoch: '0',phase: 'stable',acceptingNewOperations: true }
    const { client,transport } = setup(value)
    expect(await client.authority()).toEqual(value)
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_authority',{})
    for (const invalid of [{ ...value,epoch: 0 },{ ...value,mode: undefined },{ ...value,phase: 'quiescing' }])
      await expect(setup(invalid).client.authority()).rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('reads all owner scopes with no assistant/home/owner argument', async () => {
    const { client, transport } = setup(snapshot())
    expect((await client.snapshot()).items).toEqual([item()])
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_snapshot', { p_device_id: null })
  })
  it('keeps not-ready distinct from a ready empty account', async () => {
    const { client } = setup({ ...snapshot(), state: 'not-ready', items: [] })
    expect((await client.snapshot()).state).toBe('not-ready')
    expect(parseConnectionSnapshot({ ...snapshot(), items: [] }).state).toBe('ready')
    expect(parseConnectionSnapshot({ version: 1,state: 'not-ready',revision: '0',items: null,application: null }))
      .toEqual({ version: 1,state: 'not-ready',revision: '0',items: null,application: null })
    expect(() => parseConnectionSnapshot({ version: 1,state: 'ready',revision: '0',items: null,application: null })).toThrow('CONNECTION_RESPONSE_INVALID')
  })
  it('retains tombstones and each device scope without merging equal resource keys', () => {
    const deleted = { ...item(), deletedAt: '2026-11-07T00:00:00Z' }
    const other = { ...item(), scopeKey: 'device:other', deviceId: 'other' }
    expect(parseConnectionSnapshot({ ...snapshot(), items: [deleted, other] }).items).toEqual([deleted, other])
    expect(() => parseConnectionSnapshot({ ...snapshot(), items: [item(), item()] })).toThrow('CONNECTION_RESPONSE_INVALID')
  })
  it('rejects foreign device scope and credential fields', () => {
    for (const invalid of [{ ...item(), deviceId: 'other' }, { ...item(), publicMetadata: { accessToken: 'secret' } },
      { ...item(), data: { configured: true, credentials: { key: 'secret' } } }]) {
      expect(() => parseConnectionSnapshot({ ...snapshot(), items: [invalid] })).toThrow('CONNECTION_RESPONSE_INVALID')
    }
  })
  it('commits an original key/revision/UUID and never changes the operation on a lost response', async () => {
    const { client, transport } = setup({ operationId, revision: '5', status: 'pending',scopeKey: 'device:device',resourceKey: 'original-key' })
    await client.commit({ operationId, scopeKey: 'device:device', resourceKey: 'original-key', expectedRevision: '4', operation: 'remove', deviceId: 'device' })
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_commit', {
      p_operation_id: operationId, p_scope_key: 'device:device', p_resource_key: 'original-key', p_expected_revision: '4',
      p_operation: 'remove', p_data: {}, p_document: null, p_device_id: 'device', p_runtime_instance_id: null, p_recreation_id: null,
    })
    transport.mockRejectedValueOnce(new Error('NETWORK_LOST'))
    await expect(client.commit({ operationId, scopeKey: 'device:device', resourceKey: 'original-key', expectedRevision: '4', operation: 'remove' }))
      .rejects.toMatchObject({ code: 'transport-failed' })
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('parses migrated pending identity, admission and the original cleanup payload', async () => {
    const change = { operationId, requestHash: hash, scopeKey: 'device:device', resourceKey: 'original-key', deviceId: 'device', revision: '5',
      expectedItemRevision: '4', operation: 'remove', payload: { before: { providerId: 'github', accountId: 'account' } },
      status: 'pending', errorCode: null, terminal: false, admissionId, startedAt: '2026-11-06T00:00:00Z' }
    const { client, transport } = setup({ version: 1, revision: '6', changes: [change] })
    expect((await client.pending('runtime')).changes).toEqual([change])
    expect(transport).toHaveBeenCalledWith('connection_pending', { p_runtime_instance_id: 'runtime' })
  })
  it('separates per-operation admission from the whole-head task barrier', async () => {
    const { client, transport } = setup({ admitted: true, revision: '6', operationId, operationRevision: '5', requestHash: hash, admissionId })
    expect((await client.admit('runtime', '6', operationId)).admissionId).toBe(admissionId)
    expect(transport).toHaveBeenLastCalledWith('connection_admit', { p_runtime_instance_id: 'runtime', p_expected_revision: '6', p_operation_id: operationId })
    await client.admit('runtime', '6')
    expect(transport).toHaveBeenLastCalledWith('connection_admit', { p_runtime_instance_id: 'runtime', p_expected_revision: '6', p_operation_id: null })
  })
  it('refuses a mismatched admission UUID/hash shape and preserves already-started refusal', async () => {
    const { client } = setup({ admitted: true, revision: '6', operationId, operationRevision: '5', requestHash: hash })
    await expect(client.admit('runtime', '6', operationId)).rejects.toMatchObject({ code: 'invalid-response' })
    const refused = setup({ admitted: false, revision: '6', operationId, reason: 'already-started' })
    expect(await refused.client.admit('runtime', '6', operationId)).toMatchObject({ admitted: false, reason: 'already-started' })
  })
  it('acknowledges unknown outcomes as terminal on the original admission', async () => {
    const { client, transport } = setup({ operationId, admissionId, revision: '7', status: 'failed', errorCode: 'CONNECTION_OUTCOME_UNKNOWN', terminal: true })
    await client.ack('runtime', operationId, admissionId, 'CONNECTION_OUTCOME_UNKNOWN', true)
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_ack', { p_runtime_instance_id: 'runtime', p_operation_id: operationId,
      p_admission_id: admissionId, p_error_code: 'CONNECTION_OUTCOME_UNKNOWN', p_terminal: true })
  })
  it('binds recreation to the explicit original intent and item revision', async () => {
    const { client, transport } = setup({ operationId, recreationId: admissionId, expectedItemRevision: '4', revision: '6', expiresAt: '2026-11-07T00:00:00Z' })
    await client.recreateBegin({ operationId, scopeKey: 'device:device', resourceKey: 'original-key', expectedRevision: '4', deviceId: 'device' })
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_recreate_begin', { p_operation_id: operationId, p_scope_key: 'device:device',
      p_resource_key: 'original-key', p_expected_revision: '4', p_device_id: 'device',p_provider_id: null,p_expected_head_revision: null })
  })
  it('checks document bytes and the exact requested scope/key', async () => {
    const document = '{"version":1}'
    const current = { ...item(), document, bodySha256: createHash('sha256').update(document).digest('hex') }
    const { client } = setup({ version: 1, state: 'ready', revision: '4', item: current })
    expect((await client.resource('device:device', 'original-key')).item?.document).toBe(document)
    await expect(client.resource('device:device', 'other-key')).rejects.toMatchObject({ code: 'invalid-response' })
    const changed = setup({ version: 1, state: 'ready', revision: '4', item: { ...current, document: '{}' } })
    await expect(changed.client.resource('device:device', 'original-key')).rejects.toMatchObject({ code: 'body-changed' })
  })
  it('rejects sign-out and account changes while the transport is in flight', async () => {
    const { client, transport, account } = setup(snapshot())
    account(null)
    await expect(client.snapshot()).rejects.toMatchObject({ code: 'signed-out' })
    expect(transport).not.toHaveBeenCalled()
    account('owner')
    let settle!: (value: Awaited<ReturnType<typeof transport>>) => void
    transport.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const pending = client.snapshot()
    account('other')
    settle({ data: snapshot(), error: null })
    await expect(pending).rejects.toMatchObject({ code: 'account-changed' })
  })
})
