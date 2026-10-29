import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), error: vi.fn() }))
vi.mock('@gugu/core/cloud/userSettings', () => ({ readUserSettingsConfig: io.read, writeUserSettingsConfig: io.write }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: io.error }) }))
const { parseSampleProject, readSampleProjectShown, enrollSampleProject, subscribeSampleProject } = await import('../../../../apps/desktop/src/lib/sampleProject')

beforeEach(() => vi.resetAllMocks())

describe('account-scoped sample project key', () => {
  it('does not show the sample to accounts that never left the new intro', async () => {
    expect(parseSampleProject({ firstRunHints: { version: 1, dismissed: [] } })).toBeNull()
    io.read.mockResolvedValue({ profile: { occupation: 'research' } })
    await expect(readSampleProjectShown('owner-1')).resolves.toBe(false)
  })

  it('shows the sample only while it is enrolled and not dismissed', async () => {
    io.read.mockResolvedValueOnce({ sampleProject: { version: 1, dismissed: false } })
    await expect(readSampleProjectShown('owner-1')).resolves.toBe(true)
    io.read.mockResolvedValueOnce({ sampleProject: { version: 1, dismissed: true } })
    await expect(readSampleProjectShown('owner-1')).resolves.toBe(false)
  })

  it('does not interpret a malformed key as shown or hidden', async () => {
    for (const sampleProject of [null, [], {}, { version: 2, dismissed: false }, { version: 1 }, { version: 1, dismissed: 'no' }]) {
      expect(() => parseSampleProject({ sampleProject })).toThrow('Invalid sample project state')
    }
    io.read.mockResolvedValue({ sampleProject: { version: 2, dismissed: false } })
    await expect(readSampleProjectShown('owner-1')).rejects.toThrow('Invalid sample project state')
  })

  it('enrolls in the same account settings row, preserving everything else, and tells listeners', async () => {
    const config = { profile: { occupation: 'research' }, firstRunHints: { version: 1, dismissed: [] } }
    io.read.mockResolvedValue(config)
    const listener = vi.fn()
    const stop = subscribeSampleProject(listener)
    await enrollSampleProject('owner-1')
    stop()
    expect(io.write).toHaveBeenCalledWith({}, 'owner-1', 'user', { ...config, sampleProject: { version: 1, dismissed: false } })
    expect(listener).toHaveBeenCalledWith('owner-1')
  })

  it('keeps an existing key, including a dismissal, when the intro is left again', async () => {
    const listener = vi.fn()
    const stop = subscribeSampleProject(listener)
    for (const sampleProject of [{ version: 1, dismissed: false }, { version: 1, dismissed: true }]) {
      io.read.mockResolvedValueOnce({ sampleProject })
      await enrollSampleProject('owner-1')
    }
    stop()
    expect(io.write).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('still tells every listener, and still resolves, when one listener throws', async () => {
    io.read.mockResolvedValue({})
    const broken = vi.fn(() => { throw new Error('render failed') })
    const listener = vi.fn()
    const stops = [subscribeSampleProject(broken), subscribeSampleProject(listener)]
    await expect(enrollSampleProject('owner-1')).resolves.toBeUndefined()
    for (const stop of stops) stop()
    expect(listener).toHaveBeenCalledWith('owner-1')
    expect(io.error).toHaveBeenCalledTimes(1)
  })

  it('logs instead of throwing when enrolling fails, and never overwrites a malformed key', async () => {
    const listener = vi.fn()
    const stop = subscribeSampleProject(listener)
    io.read.mockRejectedValueOnce(new Error('offline'))
    await expect(enrollSampleProject('owner-1')).resolves.toBeUndefined()
    io.read.mockResolvedValueOnce({ sampleProject: { version: 9 } })
    await expect(enrollSampleProject('owner-1')).resolves.toBeUndefined()
    io.read.mockResolvedValueOnce({})
    io.write.mockRejectedValueOnce(new Error('permission denied'))
    await expect(enrollSampleProject('owner-1')).resolves.toBeUndefined()
    stop()
    expect(io.write).toHaveBeenCalledTimes(1)
    expect(io.error).toHaveBeenCalledTimes(3)
    expect(listener).not.toHaveBeenCalled()
  })
})
