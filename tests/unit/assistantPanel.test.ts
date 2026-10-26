import { describe, expect, it, vi } from 'vitest'
import { AssistantPanelError, assistantPanelCollection, createAssistantPanelClient, parseAssistantPanelSnapshot } from '../../packages/core/src/cloud/assistantPanel'

const item = (key: string, data: Record<string, unknown> = {}) => ({
  assistant_user_id: 'assistant',owner_user_id: 'owner',domain: 'memory',resource_key: key,
  device_id: 'home',revision: '9007199254740993',data,body_item_id: null,body_sha256: null,
  deleted_at: null,observed_at: null,updated_at: '2026-10-26T00:00:00Z',
})
const snapshot = (items: unknown[] = []) => ({ version: 1,revision: '9007199254740993',items,application: [] })

describe('assistant panel account data', () => {
  it('classifies transport failure without reclassifying snapshot or ownership failures', async () => {
    let owner = 'owner'
    const transport = vi.fn().mockRejectedValueOnce(new TypeError('private fetch diagnosis'))
      .mockRejectedValueOnce(new AssistantPanelError('stale','snapshot fact'))
      .mockImplementationOnce(async () => { owner = 'other'; throw new TypeError('fetch failed') })
    const client = createAssistantPanelClient(transport,() => owner)
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: 'transport-failed',message: 'PANEL_TRANSPORT_FAILED' })
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: 'stale' })
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: 'account-changed' })
  })
  it('distinguishes unprepared, successfully empty, failed and per-device collections', () => {
    const read = (items: unknown[]) => parseAssistantPanelSnapshot(snapshot(items),'owner','assistant')
    expect(assistantPanelCollection(read([]),'memory').state).toBe('unprepared')
    expect(assistantPanelCollection(read([item('__collection__',{ state: 'ready' })]),'memory')).toEqual({ state: 'ready',items: [] })
    expect(assistantPanelCollection(read([item('__collection__',{ state: 'error' }),item('kept')]),'memory')).toMatchObject({ state: 'error',items: [item('kept')] })
    const perDevice = read([item('__collection__:home',{ state: 'ready' }),item('here'),{ ...item('elsewhere'),device_id: 'other' }])
    expect(assistantPanelCollection(perDevice,'memory','home')).toEqual({ state: 'ready',items: [item('here')] })
    expect(assistantPanelCollection(perDevice,'memory','other').state).toBe('unprepared')
  })

  it.each([
    { ...item('foreign'),owner_user_id: 'other' },
    { ...item('foreign-assistant'),assistant_user_id: 'other' },
    { ...item('unknown'),domain: 'unexpected' },
    { ...item('rounded'),revision: Number('9007199254740993') },
    { ...item('missing-body'),body_item_id: 'body' },
  ])('rejects malformed or foreign rows instead of producing an empty list', row => {
    expect(() => parseAssistantPanelSnapshot(snapshot([row]),'owner','assistant')).toThrow('could not be read')
  })

  it('preserves bigint revisions and rejects duplicate resources', () => {
    expect(parseAssistantPanelSnapshot(snapshot([item('note')]),'owner','assistant').revision).toBe('9007199254740993')
    expect(() => parseAssistantPanelSnapshot(snapshot([item('same'),item('same')]),'owner','assistant')).toThrow()
  })

  it('drops an in-flight response after switching accounts and makes no request while signed out', async () => {
    let owner: string | null = 'owner'
    const transport = vi.fn(async () => { owner = 'other'; return { data: snapshot(),error: null } })
    const client = createAssistantPanelClient(transport,() => owner)
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: 'account-changed' })
    owner = null
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: 'signed-out' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('preserves storage failures and supports superseded receipts without dispatching to a host', async () => {
    const transport = vi.fn().mockResolvedValueOnce({ data: null,error: { code: '40001',message: 'Read it again' } })
      .mockResolvedValueOnce({ data: { operationId: 'old',revision: '17',status: 'superseded' },error: null })
      .mockResolvedValueOnce({ data: { operationId: 'notice',revision: '18',status: 'pending' },error: null })
    const client = createAssistantPanelClient(transport,() => 'owner')
    await expect(client.snapshot('assistant')).rejects.toMatchObject({ code: '40001',message: 'Read it again' })
    expect(await client.ack('assistant','runtime','old')).toMatchObject({ status: 'superseded' })
    await client.notice('assistant',{ operationId: 'notice',resource: 'projects',operation: 'edited',id: 'project' })
    expect(transport.mock.calls.map(call => call[0])).toEqual(['assistant_panel_snapshot','assistant_panel_ack','assistant_panel_notice'])
  })
})
