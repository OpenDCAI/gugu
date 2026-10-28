import { expect, it, vi } from 'vitest'
import { createAssistantSetupPreparation } from '../../../../apps/desktop/electron/assistant-setup-preparation'

function fixture() {
  const prepared = { commit: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const deps = { prepare: vi.fn(async (_id: string, _signal: AbortSignal) => prepared),
    install: vi.fn(async () => ({ home: '/home', workdir: '/home/assistant' })), changed: vi.fn() }
  return { prepared, deps, service: createAssistantSetupPreparation(deps) }
}

it('does not touch the old home while preparing; cancellation waits for cleanup', async () => {
  const f = fixture()
  f.service.start('one')
  await vi.waitFor(() => expect(f.service.status('one').phase).toBe('ready'))
  let cleaned!: () => void
  f.prepared.dispose.mockImplementationOnce(() => new Promise(resolve => { cleaned = resolve }))
  let returned = false
  const cancel = f.service.cancel('one').then(result => { returned = true; return result })
  await vi.waitFor(() => expect(f.prepared.dispose).toHaveBeenCalledOnce())
  expect(returned).toBe(false)
  expect(f.deps.install).not.toHaveBeenCalled()
  expect(f.prepared.commit).not.toHaveBeenCalled()
  cleaned()
  expect(await cancel).toBe(true)
  expect(f.service.status('one').phase).toBe('cancelled')
  await expect(f.service.commit('one', {})).rejects.toThrow('not ready')
})

it('atomically rejects cancellation once the first active write is claimed', async () => {
  const f = fixture()
  f.service.start('one')
  await vi.waitFor(() => expect(f.service.status('one').phase).toBe('ready'))
  let release!: () => void
  f.prepared.commit.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const commit = f.service.commit('one', { fresh: true })
  expect(await f.service.cancel('one')).toBe(false)
  expect(f.service.status('one').phase).toBe('committing')
  release()
  await expect(commit).resolves.toMatchObject({ workdir: '/home/assistant' })
  expect(f.deps.install).toHaveBeenCalledOnce()
})

it('does not report cancellation when cleanup failed', async () => {
  const f = fixture()
  f.service.start('one')
  await vi.waitFor(() => expect(f.service.status('one').phase).toBe('ready'))
  f.prepared.dispose.mockRejectedValueOnce(new Error('Disk error'))
  await expect(f.service.cancel('one')).rejects.toThrow('Disk error')
  expect(f.service.status('one').phase).not.toBe('cancelled')
  expect(f.deps.install).not.toHaveBeenCalled()
})

it('cancels an unfinished download and never installs its late result', async () => {
  const f = fixture()
  let finish!: (result: typeof f.prepared) => void
  f.deps.prepare.mockImplementationOnce(async (_id, signal) => {
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    return await new Promise(resolve => { finish = resolve })
  })
  f.service.start('one')
  const cancel = f.service.cancel('one')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  finish(f.prepared)
  expect(await cancel).toBe(true)
  expect(f.prepared.commit).not.toHaveBeenCalled()
  expect(f.deps.install).not.toHaveBeenCalled()
})
