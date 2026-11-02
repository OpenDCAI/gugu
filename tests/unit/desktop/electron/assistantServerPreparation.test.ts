import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantServerOperation, AssistantServerPreparation } from '../../../../apps/desktop/src/lib/assistantServerSetupTypes'
import { createAssistantServerPreparation, type ServerPreparationRecord } from '../../../../apps/desktop/electron/assistant-server-preparation'
import { assistantServerFailure, AssistantServerSetupError } from '../../../../apps/desktop/src/lib/assistantServerSetupTypes'

const input = { ownerUserId: 'owner', deviceId: 'server', operationId: 'operation', ownerProfile: 'Owner' }
function fixture(initial: ServerPreparationRecord | null = null) {
  let disk = initial ? structuredClone(initial) : null
  const cancellations = new Map<string, AssistantServerPreparation>()
  const runtime = { commit: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const deps = {
    read: vi.fn(async () => disk ? structuredClone(disk) : null),
    write: vi.fn(async (record: ServerPreparationRecord) => { disk = structuredClone(record) }),
    readCancellation: vi.fn(async (operation: AssistantServerOperation) => cancellations.get(operation.operationId) ?? null),
    writeCancellation: vi.fn(async (operation: AssistantServerOperation, state: AssistantServerPreparation) => { cancellations.set(operation.operationId, structuredClone(state)) }),
    validate: vi.fn(async () => {}), retired: vi.fn(async () => false), prepare: vi.fn(async (_id: string, _signal: AbortSignal) => runtime), cleanup: vi.fn(async (_id: string, _keepRuntime: boolean) => {}),
    wipe: vi.fn(async () => ({ workdir: '/account/assistant', existed: true })), install: vi.fn(async () => ({ home: '/account', workdir: '/account/assistant' })), log: vi.fn(),
  }
  const service = createAssistantServerPreparation(deps)
  const wait = async (phase: string) => { await vi.waitFor(async () => expect((await service.status(input)).phase).toBe(phase)); return service.status(input) }
  return { service, deps, runtime, wait, restart: () => createAssistantServerPreparation(deps), disk: () => structuredClone(disk) }
}

describe('durable account-host assistant preparation', () => {
  it('persists cancellation before start is received and rejects a late start after restart and a newer operation', async () => {
    const f = fixture()
    await expect(f.service.cancel(input)).resolves.toMatchObject({ cancelled: true, state: { phase: 'cancelled' } })
    expect(f.deps.writeCancellation).toHaveBeenCalledOnce()
    const restarted = f.restart()
    expect(await restarted.start(input)).toMatchObject({ phase: 'cancelled' })
    expect(f.deps.prepare).not.toHaveBeenCalled()
    await restarted.start({ ...input, operationId: 'new' })
    await vi.waitFor(() => expect(f.disk()?.state.phase).toBe('prepared'))
    expect(await f.restart().start(input)).toMatchObject({ phase: 'cancelled' })
    expect(f.deps.prepare).toHaveBeenCalledOnce()
    expect(f.disk()?.operationId).toBe('new')
  })
  it.each(['runtime', 'cancelled'] as const)('cleans persisted staging after host restart, including a legacy %s record', async phase => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-interrupted-cancel-'))
    const staged = join(root, `${input.operationId}-7`)
    await mkdir(staged)
    try {
      const f = fixture({ ...input, version: 1, attempt: 7, freshCleared: false,
        state: { operationId: input.operationId, phase, installationStarted: false, cancellable: phase !== 'cancelled' } })
      f.deps.cleanup.mockImplementation(async id => { await rm(join(root, id), { recursive: true, force: true }) })
      expect(await f.service.cancel(input)).toMatchObject({ cancelled: true })
      expect(f.deps.cleanup).toHaveBeenCalledWith(`${input.operationId}-7`, false)
      await expect(access(staged)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await f.restart().start(input)).toMatchObject({ phase: 'cancelled' })
      expect(f.deps.prepare).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('does not confirm interrupted cancellation when cleanup fails, and retries that same attempt', async () => {
    const f = fixture({ ...input, version: 1, attempt: 3, freshCleared: false,
      state: { operationId: input.operationId, phase: 'runtime', installationStarted: false, cancellable: true } })
    f.deps.cleanup.mockRejectedValueOnce(new Error('cannot remove staging'))
    await expect(f.service.cancel(input)).rejects.toMatchObject({ code: 'cleanup_failed' })
    expect(f.deps.writeCancellation).not.toHaveBeenCalled()
    expect(await f.service.status(input)).toMatchObject({ phase: 'failed', error: { code: 'cleanup_failed' } })
    expect(await f.restart().cancel(input)).toMatchObject({ cancelled: true })
    expect(f.deps.cleanup.mock.calls).toEqual([[`${input.operationId}-3`, false], [`${input.operationId}-3`, false]])
  })
  it('does not acknowledge cancellation until the cancellation record is durable', async () => {
    const f = fixture()
    f.deps.writeCancellation.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(f.service.cancel(input)).rejects.toThrow('disk unavailable')
    expect(await f.deps.readCancellation(input)).toBeNull()
    expect(await f.service.cancel(input)).toMatchObject({ cancelled: true })
  })
  it('cancels an unreceived operation without aborting a different active preparation', async () => {
    const f = fixture()
    f.deps.prepare.mockImplementationOnce(() => new Promise(() => {}))
    await f.service.start(input)
    await f.wait('runtime')
    const other = { ...input, operationId: 'never-received' }
    expect(await f.service.cancel(other)).toMatchObject({ cancelled: true })
    expect(f.deps.prepare.mock.calls[0]![1].aborted).toBe(false)
    expect(f.disk()?.operationId).toBe(input.operationId)
    expect(f.deps.cleanup).not.toHaveBeenCalled()
    expect(await f.service.start(other)).toMatchObject({ phase: 'cancelled' })
    expect(f.deps.prepare).toHaveBeenCalledOnce()
  })
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
  it('retains the operation and reports runtime publication failure before any home write', async () => {
    const f = fixture()
    f.runtime.commit.mockRejectedValueOnce(new Error('published runtime not discoverable'))
    await f.service.start(input)
    expect(await f.wait('failed')).toMatchObject({ error: { code: 'runtime_failed' }, installationStarted: true })
    expect(f.deps.wipe).not.toHaveBeenCalled()
    expect(f.deps.install).not.toHaveBeenCalled()
    await f.service.start(input)
    await f.wait('prepared')
    expect(f.disk()?.operationId).toBe(input.operationId)
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
    await f.service.closeHome(input.operationId)
    await f.service.start({ ...input, operationId: 'new' })
    await vi.waitFor(() => expect(f.disk()?.state.phase).toBe('prepared'))
    expect(f.deps.wipe).toHaveBeenCalledTimes(3)
    await expect(f.service.closeHome(input.operationId)).rejects.toMatchObject({ code: 'input_mismatch' })
    expect(f.deps.wipe).toHaveBeenCalledTimes(3)
  })
  it('allows fresh setup to finish residual cleanup only after authoritative identity retirement', async () => {
    const f = fixture()
    await f.service.start(input)
    await f.wait('prepared')
    f.deps.wipe.mockRejectedValueOnce(new Error('close cleanup interrupted'))
    await expect(f.service.closeHome(input.operationId)).rejects.toThrow('close cleanup interrupted')
    await expect(f.service.start({ ...input, operationId: 'new' })).rejects.toMatchObject({ code: 'preparation_busy' })
    f.deps.retired.mockResolvedValueOnce(true)
    await f.service.start({ ...input, operationId: 'new' })
    await vi.waitFor(() => expect(f.disk()?.state.phase).toBe('prepared'))
    expect(f.disk()?.operationId).toBe('new')
    await expect(f.service.closeHome(input.operationId)).rejects.toMatchObject({ code: 'input_mismatch' })
  })
})
