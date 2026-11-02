import { describe, expect, it, vi } from 'vitest'
import { createAssistantServerPreparation, type ServerPreparationRecord } from '../../../../apps/desktop/electron/assistant-server-preparation'
import { assistantServerFailure, AssistantServerSetupError } from '../../../../apps/desktop/src/lib/assistantServerSetupTypes'

const input = { ownerUserId: 'owner', deviceId: 'server', operationId: 'operation', ownerProfile: 'Owner' }
function fixture(initial: ServerPreparationRecord | null = null) {
  let disk = initial ? structuredClone(initial) : null
  const runtime = { commit: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const deps = {
    read: vi.fn(async () => disk ? structuredClone(disk) : null),
    write: vi.fn(async (record: ServerPreparationRecord) => { disk = structuredClone(record) }),
    validate: vi.fn(async () => {}), prepare: vi.fn(async (_id: string, _signal: AbortSignal) => runtime), cleanup: vi.fn(async () => {}),
    wipe: vi.fn(async () => {}), install: vi.fn(async () => ({ home: '/account', workdir: '/account/assistant' })), log: vi.fn(),
  }
  const service = createAssistantServerPreparation(deps)
  const wait = async (phase: string) => { await vi.waitFor(async () => expect((await service.status(input)).phase).toBe(phase)); return service.status(input) }
  return { service, deps, runtime, wait, disk: () => structuredClone(disk) }
}

describe('durable account-host assistant preparation', () => {
  it('publishes real phases and only reports prepared after runtime and home succeed', async () => {
    const f = fixture()
    await f.service.start(input)
    expect(await f.wait('prepared')).toMatchObject({ cancellable: false, installationStarted: true, home: { workdir: '/account/assistant' } })
    expect(f.deps.write.mock.calls.map(([record]) => record.state.phase)).toEqual(expect.arrayContaining(['prepared']))
    expect(f.runtime.commit).toHaveBeenCalledOnce()
    expect(f.deps.wipe).toHaveBeenCalledOnce()
    expect(f.deps.install).toHaveBeenCalledWith('Owner')
    await f.service.start(input)
    expect(f.deps.install).toHaveBeenCalledOnce()
  })
  it('does zero writes for an offline/unauthorized target', async () => {
    const f = fixture()
    f.deps.validate.mockRejectedValue(new AssistantServerSetupError(assistantServerFailure('target_not_owned')))
    await expect(f.service.start(input)).rejects.toMatchObject({ code: 'target_not_owned' })
    expect(f.deps.write).not.toHaveBeenCalled()
    expect(f.deps.prepare).not.toHaveBeenCalled()
    expect(f.deps.install).not.toHaveBeenCalled()
  })
  it('retries an interrupted home write on the same operation without wiping twice', async () => {
    const f = fixture()
    f.deps.install.mockRejectedValueOnce(new Error('disk unavailable'))
    await f.service.start(input)
    expect(await f.wait('failed')).toMatchObject({ error: { code: 'workspace_failed' }, installationStarted: true })
    expect(await f.service.cancel(input)).toMatchObject({ cancelled: false })
    await f.service.start(input)
    await f.wait('prepared')
    expect(f.deps.wipe).toHaveBeenCalledOnce()
    expect(f.deps.install).toHaveBeenCalledTimes(2)
    expect(f.disk()?.attempt).toBe(2)
  })
  it('survives an account process restart and keeps its original target and installation fence', async () => {
    const f = fixture({ ...input, version: 1, attempt: 1, freshCleared: true,
      state: { operationId: input.operationId, phase: 'workspace', installationStarted: true, cancellable: false } })
    expect(await f.service.status(input)).toMatchObject({ phase: 'failed', installationStarted: true, error: { code: 'interrupted' } })
    await f.service.start(input)
    await f.wait('prepared')
    expect(f.deps.wipe).not.toHaveBeenCalled()
    expect(f.disk()?.deviceId).toBe('server')
  })
  it('waits for cancellation cleanup and never publishes a late runtime result', async () => {
    const f = fixture()
    let release!: () => void
    f.deps.prepare.mockImplementationOnce(async (_id, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { release = resolve }, { once: true }))
      return f.runtime
    })
    await f.service.start(input)
    await f.wait('runtime')
    let done = false
    const cancelled = f.service.cancel(input).then(value => { done = true; return value })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(done).toBe(false)
    release()
    expect(await cancelled).toMatchObject({ cancelled: true, state: { phase: 'cancelled' } })
    expect(f.runtime.dispose).toHaveBeenCalledOnce()
    expect(f.runtime.commit).not.toHaveBeenCalled()
    expect(f.deps.wipe).not.toHaveBeenCalled()
  })
  it('rejects cancellation immediately after the first active-write fence', async () => {
    const f = fixture()
    let release!: () => void
    f.runtime.commit.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await f.service.start(input)
    await f.wait('workspace')
    expect(await f.service.cancel(input)).toMatchObject({ cancelled: false })
    release()
    await f.wait('prepared')
  })
  it('keeps failed cleanup visible instead of claiming cancellation succeeded', async () => {
    const f = fixture()
    let release!: () => void
    f.deps.prepare.mockImplementationOnce(async (_id, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { release = resolve }, { once: true }))
      return f.runtime
    })
    f.runtime.dispose.mockRejectedValueOnce(new Error('cleanup denied'))
    f.deps.cleanup.mockRejectedValueOnce(new Error('cleanup still denied'))
    await f.service.start(input)
    await f.wait('runtime')
    const cancelled = f.service.cancel(input)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await expect(cancelled).rejects.toMatchObject({ code: 'cleanup_failed' })
    expect(await f.service.status(input)).toMatchObject({ phase: 'failed', error: { code: 'cleanup_failed' } })
    expect(await f.service.cancel(input)).toMatchObject({ cancelled: true })
  })
  it('serializes concurrent starts and refuses changed draft, target or operation', async () => {
    const f = fixture()
    f.deps.prepare.mockImplementationOnce(() => new Promise(() => {}))
    await Promise.all([f.service.start(input), f.service.start(input)])
    expect(f.deps.prepare).toHaveBeenCalledOnce()
    await expect(f.service.start({ ...input, ownerProfile: 'Another' })).rejects.toMatchObject({ code: 'input_mismatch' })
    await expect(f.service.start({ ...input, deviceId: 'another' })).rejects.toMatchObject({ code: 'input_mismatch' })
    await expect(f.service.start({ ...input, operationId: 'another' })).rejects.toMatchObject({ code: 'preparation_busy' })
  })
  it('allows a new assistant only after closing the old home', async () => {
    const f = fixture()
    await f.service.start(input)
    await f.wait('prepared')
    await expect(f.service.start({ ...input, operationId: 'new' })).rejects.toMatchObject({ code: 'preparation_busy' })
    await f.service.closed()
    await f.service.start({ ...input, operationId: 'new' })
    await vi.waitFor(() => expect(f.disk()?.state.phase).toBe('prepared'))
    expect(f.deps.wipe).toHaveBeenCalledTimes(2)
  })
})
