import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ASSISTANT_HOME_CHANNELS } from '../../../../apps/desktop/src/lib/assistantHomeIpc'
import { initLogging, resetLoggingForTests } from '../../../../apps/desktop/electron/lib/logger'

const f = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  prepare: vi.fn(), commit: vi.fn(),
}))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => f.handlers.set(channel, handler) } }))
vi.mock('../../../../apps/desktop/electron/assistant-home-prepare', () => ({ prepareLocalAssistantHome: vi.fn(), wipeLocalAssistantHome: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/assistant-runtime-prepare', () => ({ prepareAssistantRuntime: f.prepare, discardAssistantPreparation: vi.fn() }))
const { installAssistantHome } = await import('../../../../apps/desktop/electron/assistant-home')
let dir = ''
afterEach(() => { resetLoggingForTests(); if (dir) rmSync(dir, { recursive: true, force: true }); vi.resetAllMocks(); f.handlers.clear() })

it.each(['prepare', 'commit'] as const)('writes the original %s failure into gugu-main.log through the real IPC wiring', async stage => {
  dir = mkdtempSync(join(tmpdir(), 'assistant-log-935-'))
  initLogging({ dir, stdout: false })
  const original = Object.assign(new Error('launcher sharing violation', { cause: new Error('original filesystem failure') }), { code: 'EPERM' })
  if (stage === 'prepare') f.prepare.mockRejectedValueOnce(original)
  else {
    f.commit.mockRejectedValueOnce(original)
    f.prepare.mockResolvedValueOnce({ commit: f.commit, dispose: vi.fn() })
  }
  installAssistantHome()
  const event = { sender: { once: vi.fn(), isDestroyed: () => false, send: vi.fn() } }
  const started = f.handlers.get(ASSISTANT_HOME_CHANNELS.preparationStart)!(event) as { id: string }
  if (stage === 'commit') {
    await vi.waitFor(() => expect(f.handlers.get(ASSISTANT_HOME_CHANNELS.preparationStatus)!(event, started.id)).toMatchObject({ phase: 'ready' }))
    await expect(f.handlers.get(ASSISTANT_HOME_CHANNELS.preparationCommit)!(event, started.id, {})).rejects.toThrow('launcher sharing violation')
  }
  await vi.waitFor(() => {
    const rows = readFileSync(join(dir, 'gugu-main.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toContainEqual(expect.objectContaining({
      level: 40, scope: 'assistant-setup-preparation', stage, attemptId: started.id,
      msg: 'Local assistant setup failed',
      error: expect.objectContaining({ message: 'launcher sharing violation', code: 'EPERM', cause: expect.objectContaining({ message: 'original filesystem failure' }) }),
    }))
  })
})
