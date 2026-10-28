import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ config: {} as Record<string, unknown>, writes: [] as Record<string, unknown>[] }))
vi.mock('@gugu/core/cloud/userSettings', () => ({
  readUserSettingsConfig: async () => io.config,
  mutateUserSettingsConfig: async (_client: unknown, _user: string, _scope: string, change: (value: Record<string, unknown>) => Record<string, unknown>) => {
    const config = change(io.config)
    io.writes.push(config)
    io.config = config
    return config
  },
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
const { readFileStorage, writeFileStorage } = await import('../../../../apps/desktop/src/lib/fileStorage')

describe('the file storage setting across client versions', () => {
  beforeEach(() => {
    io.writes = []
    io.config = { other: 'keep', file_storage: { image_retention: '30d', temporary_retention: '1d', later_key: { any: 1 } } }
  })
  it('reads a setting a newer client wrote, and writing back keeps the keys this client does not know', async () => {
    expect(await readFileStorage('u')).toMatchObject({ image_retention: '30d', retention: '7d' })
    await writeFileStorage('u', { retention: '1d' })
    expect(io.writes).toEqual([{ other: 'keep', file_storage: {
      proactive_upload: false, temporary_transfer: true, retention: '1d', image_retention: '30d', temporary_retention: '1d', later_key: { any: 1 },
    } }])
  })
})
