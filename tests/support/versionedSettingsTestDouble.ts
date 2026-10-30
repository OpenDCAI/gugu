import type { VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'

export function versionedSettingsClient(state: {
  rows: Map<string, Record<string, unknown>>
  failWrite: boolean
  failRead?: boolean
  readWait?: Promise<void> | null
  writeWait?: Promise<void> | null
  writing?: boolean
  conflicts?: number
  reads?: number
}): VersionedSettingsTableClient {
  const keyOf = (row: Record<string, unknown>) => `${row.user_id}/${row.scope}`
  const write = async (values: Record<string, unknown>, mode: 'insert' | 'update' | 'upsert', filters: Record<string, string> = {}) => {
    if (state.failWrite) return { data: null, error: { message: 'write refused' } }
    state.writing = true
    if (state.writeWait) await state.writeWait
    const key = keyOf(values)
    const before = state.rows.get(key)
    if (mode === 'insert' && before) return { data: null, error: { message: 'duplicate key', code: '23505' } }
    if (mode === 'update' && (!before || filters.updated_at !== before.updated_at || filters.scope !== before.scope || filters.user_id !== values.user_id)) {
      state.conflicts = (state.conflicts ?? 0) + 1
      return { data: null, error: null }
    }
    const row = structuredClone(values)
    state.rows.set(key, row)
    return { data: structuredClone(row), error: null }
  }
  return { from: () => ({
    select: () => {
      const filters: Record<string, string> = {}
      const query = {
        eq: (column: string, value: string) => { filters[column] = value; return query },
        maybeSingle: async () => {
          state.reads = (state.reads ?? 0) + 1
          const data = structuredClone(state.rows.get(`${filters.user_id}/${filters.scope}`) ?? null)
          const wait = state.readWait; state.readWait = null
          if (wait) await wait
          return { data, error: state.failRead ? { message: 'read refused' } : null }
        },
      }
      return query
    },
    update: (values: Record<string, unknown>) => {
      const filters: Record<string, string> = {}
      const query = {
        eq: (column: string, value: string) => { filters[column] = value; return query },
        select: () => ({ maybeSingle: () => write(values, 'update', filters) }),
      }
      return query
    },
    insert: (values: Record<string, unknown>) => ({ select: () => ({ maybeSingle: () => write(values, 'insert') }) }),
    upsert: (values: Record<string, unknown>) => ({ select: () => ({ single: () => write(values, 'upsert') }) }),
  }) } as VersionedSettingsTableClient
}
