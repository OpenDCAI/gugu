import { beforeEach, describe, expect, it, vi } from 'vitest'
import { displayIdentity } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: { from: mocks.from } }))
vi.mock('../../../../apps/desktop/src/lib/authSessionLoss', () => ({ currentAuthSessionSignal: () => undefined }))

import { DISPLAY_IDENTITY_SELECT, readDeviceDisplayIdentities, readDisplayIdentities, readOwnedDisplayIdentities } from '../../../../apps/desktop/src/lib/identityReadAdapter'

type Failure = { code: string; message: string }
type Result = { data: unknown[] | null; error: Failure | null }
type Query = { table: string; projection?: string; filters: [string, unknown][]; signal?: AbortSignal; order?: string }
const missingSerial = { code: '42703', message: 'column active_users.name_serial does not exist' }
const legacyProjection = DISPLAY_IDENTITY_SELECT.replace(', name_serial', '')

describe('live identity directory during a backend rollout', () => {
  let results: Result[]
  let queries: Query[]
  const row = { ...displayIdentity('task-1', { type: 'agent', display_name: 'Saved task' }), nameSerial: undefined }
  const signal = new AbortController().signal
  const readers = [
    { name: 'owned tasks', read: () => readOwnedDisplayIdentities('owner-1', signal), filters: [['type', 'agent'], ['owner_user_id', 'owner-1']], signal },
    { name: 'device tasks', read: () => readDeviceDisplayIdentities('device-1'), filters: [['type', 'agent'], ['device_id', 'device-1']], order: 'display_name' },
  ] as const

  beforeEach(() => {
    results = []
    queries = []
    mocks.from.mockReset().mockImplementation((table: string) => {
      const query: Query = { table, filters: [] }
      queries.push(query)
      const result = results.shift()
      if (!result) throw new Error('Unexpected extra identity request')
      const builder = {
        select: (projection: string) => { query.projection = projection; return builder },
        eq: (column: string, value: unknown) => { query.filters.push([column, value]); return builder },
        in: (column: string, value: unknown) => { query.filters.push([column, value]); return builder },
        abortSignal: (value: AbortSignal) => { query.signal = value; return Promise.resolve(result) },
        order: (column: string) => { query.order = column; return Promise.resolve(result) },
      }
      return builder
    })
  })

  describe.each(readers)('$name', (reader) => {
    it('keeps the stored serial with one request on an updated backend', async () => {
      results.push({ data: [{ ...row, name_serial: 93 }], error: null })
      await expect(reader.read()).resolves.toEqual([displayIdentity('task-1', { type: 'agent', display_name: 'Saved task', nameSerial: 93 })])
      expect(queries).toHaveLength(1)
      expect(queries[0].projection).toBe(DISPLAY_IDENTITY_SELECT)
    })

    it('retries only the old projection and leaves an unavailable serial absent', async () => {
      results.push({ data: null, error: missingSerial }, { data: [row], error: null })
      await expect(reader.read()).resolves.toEqual([displayIdentity('task-1', { type: 'agent', display_name: 'Saved task', nameSerial: null })])
      expect(queries).toEqual([DISPLAY_IDENTITY_SELECT, legacyProjection].map((projection) => ({
        table: 'active_users', projection, filters: reader.filters,
        ...('signal' in reader ? { signal: reader.signal } : { order: reader.order }),
      })))
      expect(row).not.toHaveProperty('name_serial')
    })

    it.each([
      { code: '42703', message: 'column active_users.avatar does not exist' },
      { code: '42703', message: 'column users.name_serial does not exist' },
      { code: 'PGRST100', message: missingSerial.message },
      { code: '42501', message: 'permission denied for view active_users' },
      { code: '', message: 'TypeError: Failed to fetch' },
    ])('reports $code / $message without retrying', async (error) => {
      results.push({ data: null, error })
      await expect(reader.read()).rejects.toThrow(error.message)
      expect(queries).toHaveLength(1)
    })

    it('reports a failed legacy request without a third request', async () => {
      results.push({ data: null, error: missingSerial }, { data: null, error: { code: '42501', message: 'permission denied on retry' } })
      await expect(reader.read()).rejects.toThrow('permission denied on retry')
      expect(queries).toHaveLength(2)
    })
  })

  it('keeps canonical users reads on their current projection without retrying', async () => {
    results.push({ data: null, error: missingSerial })
    await expect(readDisplayIdentities(['task-1'], signal)).rejects.toThrow(missingSerial.message)
    expect(queries).toEqual([{ table: 'users', projection: DISPLAY_IDENTITY_SELECT, filters: [['id', ['task-1']]], signal }])
  })
})
