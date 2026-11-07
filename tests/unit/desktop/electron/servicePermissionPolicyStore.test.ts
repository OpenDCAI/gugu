import { describe, expect, it, vi } from 'vitest'
import { ServicePermissionPolicyStore } from '../../../../apps/desktop/electron/permissions/policy-store'
import { defaultPermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'
import type { VersionedSettingsTableClient } from '../../../../packages/core/src/cloud/userSettings'
import { observePermissionPolicyWrites } from '../../../../apps/desktop/electron/permissions/policy-write-lifetime'

function fixture() {
  const state = { row: { scope: 'user', config: { unrelated: { keep: true } } as Record<string, unknown>, updated_at: '2026-01-01T00:00:00.000Z' }, race: false }
  const abortSignal = vi.fn()
  const from = vi.fn((table: string) => {
    expect(table).toBe('user_settings')
    return {
      select: () => {
        const query = {
          eq: vi.fn((_key: string, _value: string) => query),
          abortSignal: (signal: AbortSignal) => { abortSignal(signal); return query },
          maybeSingle: async () => ({ data: structuredClone(state.row), error: null }),
        }
        return query
      },
      update: (value: typeof state.row) => {
        const expected: Record<string, string> = {}
        const update = {
          eq: (key: string, value: string) => { expected[key] = value; return update },
          select: () => ({ maybeSingle: async () => {
            if (state.race) {
              state.row.updated_at = '2026-01-02T00:00:00.000Z'
              state.row.config.concurrent_preference = 'preserve this'
              state.race = false
            }
            if (expected.updated_at !== state.row.updated_at) return { data: null, error: null }
            state.row = value
            return { data: structuredClone(value), error: null }
          } }),
        }
        return update
      },
    }
  })
  return { state, abortSignal, from, store: new ServicePermissionPolicyStore({ from } as unknown as VersionedSettingsTableClient) }
}

describe('account-scoped service permission settings', () => {
  it('withdraws local policy facts before settings I/O and releases the barrier after a failed write', async () => {
    const f = fixture(), events: boolean[] = []
    const off = observePermissionPolicyWrites('owner', pending => events.push(pending))
    try {
      f.state.row.config.service_permissions = { ...defaultPermissionPolicy(), revision: 3 }
      const pending = f.store.write({ kind: 'person', userId: 'owner' }, 'owner', defaultPermissionPolicy())
      expect(events).toEqual([false, true])
      await expect(pending).rejects.toThrow('reload before saving')
      expect(events).toEqual([false, true, false])
    } finally { off() }
  })
  it('preserves unrelated settings through compare-and-set retries', async () => {
    const f = fixture()
    f.state.race = true
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ id: 'read', tool: 'message_history', effect: 'allow' }]
    await f.store.write({ kind: 'person', userId: 'owner' }, 'owner', policy)
    expect(f.state.row.config).toMatchObject({ unrelated: { keep: true }, concurrent_preference: 'preserve this', service_permissions: { revision: 1, user: { rules: policy.user.rules } } })
    expect(f.from).toHaveBeenCalledTimes(4)
  })
  it('rejects a stale permission revision without overwriting the newer policy', async () => {
    const f = fixture()
    f.state.row.config.service_permissions = { ...defaultPermissionPolicy(), revision: 3 }
    await expect(f.store.write({ kind: 'person', userId: 'owner' }, 'owner', defaultPermissionPolicy())).rejects.toThrow('reload before saving')
    expect(f.state.row.config.service_permissions).toMatchObject({ revision: 3 })
  })
  it('defaults only when absent, propagates malformed configuration, and passes cancellation into the read query', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    expect(await f.store.read('owner', signal)).toEqual(defaultPermissionPolicy())
    expect(f.abortSignal).toHaveBeenCalledWith(signal)
    f.state.row.config.service_permissions = { confirmed: true, user: { rules: [] } }
    await expect(f.store.read('owner')).rejects.toThrow()
  })
})
