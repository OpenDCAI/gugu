import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@gugu/core/cloud/userSettings', () => ({ readUserSettingsConfig: io.read, writeUserSettingsConfig: io.write }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
const { allFirstRunHintsDismissed, parseFirstRunHints, readFirstRunHints, startFirstRunHints, dismissFirstRunHints } = await import('../../../../apps/desktop/src/lib/firstRunHints')

beforeEach(() => vi.resetAllMocks())

describe('account-scoped contextual first-run progress', () => {
  it('does not enroll existing accounts without the new intro', () => {
    expect(parseFirstRunHints({ profile: { occupation: 'research' } })).toBeNull()
  })

  it('does not interpret malformed progress as new or complete', () => {
    for (const firstRunHints of [null, [], {}, { version: 2, dismissed: [] }, { version: 1, dismissed: ['unknown'] }, { version: 1, dismissed: null }]) {
      expect(() => parseFirstRunHints({ firstRunHints })).toThrow('Invalid first-run hint progress')
    }
  })

  it('reads a saved dismissal of the retired topics hint and drops it', () => {
    expect(parseFirstRunHints({ firstRunHints: { version: 1, dismissed: ['assistant', 'topics'] } })).toEqual({ version: 1, dismissed: ['assistant'] })
  })

  it('counts as finished once every hint this device shows is dismissed, whatever was retired', () => {
    const phoneDone = parseFirstRunHints({ firstRunHints: { version: 1, dismissed: ['assistant', 'topics', 'collaboration'] } })!
    // A phone never shows the desktop tour hint, so it must not wait for it.
    expect(allFirstRunHintsDismissed(phoneDone, ['assistant', 'collaboration'])).toBe(true)
    expect(allFirstRunHintsDismissed(phoneDone, ['tour', 'assistant', 'collaboration'])).toBe(false)
    expect(allFirstRunHintsDismissed({ version: 1, dismissed: ['tour', 'assistant', 'collaboration'] })).toBe(true)
    expect(allFirstRunHintsDismissed({ version: 1, dismissed: ['assistant'] }, ['assistant', 'collaboration'])).toBe(false)
  })

  it('enrolls in the same account settings row, preserving the profile and harness choice', async () => {
    const config = { profile: { occupation: 'research' }, firstRunHarness: ['codex'] }
    io.read.mockResolvedValue(config)
    await startFirstRunHints('owner-1')
    expect(io.write).toHaveBeenCalledWith({}, 'owner-1', 'user', { ...config, firstRunHints: { version: 1, dismissed: [] } })
  })

  it('keeps previous hints retired when the intro completion is retried', async () => {
    io.read.mockResolvedValue({ firstRunHints: { version: 1, dismissed: ['assistant'] } })
    await startFirstRunHints('owner-1')
    expect(io.write).not.toHaveBeenCalled()
  })

  it('merges retired entries and preserves unrelated settings on each write', async () => {
    const config = { theme: 'dark', firstRunHints: { version: 1, dismissed: ['assistant'] } }
    io.read.mockResolvedValue(config)
    await expect(dismissFirstRunHints('owner-1', ['assistant', 'collaboration'])).resolves.toEqual({ version: 1, dismissed: ['assistant', 'collaboration'] })
    expect(io.write).toHaveBeenCalledWith({}, 'owner-1', 'user', { ...config, firstRunHints: { version: 1, dismissed: ['assistant', 'collaboration'] } })
  })

  it('reads the same progress on another device and keeps accounts separate', async () => {
    io.read.mockImplementation(async (_client, userId) => userId === 'owner-1' ? { firstRunHints: { version: 1, dismissed: ['assistant', 'collaboration'] } } : {})
    expect(await readFirstRunHints('owner-1')).toEqual(await readFirstRunHints('owner-1'))
    expect(await readFirstRunHints('owner-2')).toBeNull()
  })

  it('propagates read and write failures instead of inventing completion', async () => {
    io.read.mockRejectedValueOnce(new Error('permission denied'))
    await expect(readFirstRunHints('owner-1')).rejects.toThrow('permission denied')
    io.read.mockResolvedValue({ firstRunHints: { version: 1, dismissed: [] } })
    io.write.mockRejectedValueOnce(new Error('offline'))
    await expect(dismissFirstRunHints('owner-1', ['collaboration'])).rejects.toThrow('offline')
  })
})
