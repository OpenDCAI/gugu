import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ root: '', available: false, probe: vi.fn(), install: vi.fn() }))
vi.mock('@gugu/session-core/deps/runtime', () => ({ agentProgramsOf: () => [{ dependencyId: 'claude-code' }] }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/plugin-registry', () => ({ getPlugin: () => ({}) }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/managed-agent-home', () => ({
  managedAgentPrefix: () => f.root, managedMiseBinDir: () => path.join(f.root, 'bin'),
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/mise-installer', () => ({ runMiseOperation: f.install }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/ensure-agent-installed', () => ({ AgentInstallFailedError: Error }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/dependency-managers', () => ({ getDependencyManager: async () => ({
  probe: f.probe, get: () => ({ status: f.available ? 'available' : 'missing' }),
  getInstallOptions: () => [{ recommended: true, target: { kind: 'mise', binary: 'claude' } }],
}) }))
const { prepareAssistantRuntime } = await import('../../../../apps/desktop/electron/assistant-runtime-prepare')
const launcher = () => path.join(f.root, 'bin', 'claude' + (process.platform === 'win32' ? '.cmd' : ''))
beforeEach(async () => {
  vi.resetAllMocks(); f.available = false
  f.root = await mkdtemp(path.join(os.tmpdir(), 'assistant-runtime-'))
  f.install.mockImplementation(async (_operation, paths) => {
    await mkdir(paths.launcherDir, { recursive: true })
    await writeFile(path.join(paths.launcherDir, path.basename(launcher())), 'prepared ' + paths.root)
    return { success: true }
  })
})
afterEach(async () => { await rm(f.root, { recursive: true, force: true }) })

it.each([true, false])('handles concurrent publication only when its runtime probes available: %s', async valid => {
  f.probe.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    // Another installer wins after our last probe but before exclusive link().
    await writeFile(launcher(), valid ? 'usable concurrent runtime' : 'broken launcher')
  }).mockImplementation(async () => { f.available = valid })
  const prepared = await prepareAssistantRuntime('one', new AbortController().signal)
  if (valid) await expect(prepared.commit()).resolves.toBeUndefined()
  else await expect(prepared.commit()).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(launcher(), 'utf8')).toBe(valid ? 'usable concurrent runtime' : 'broken launcher')
  await prepared.dispose()
})

it('withdraws its own launcher when the published runtime does not probe available, so a retry succeeds', async () => {
  const first = await prepareAssistantRuntime('one', new AbortController().signal)
  await expect(first.commit()).rejects.toThrow('could not be started')
  await first.dispose()
  await expect(access(launcher())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(path.join(f.root, 'prepared', 'one'))).rejects.toMatchObject({ code: 'ENOENT' })

  // Retry: missing before preparation and publication, available once its own launcher is published.
  f.probe.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementation(async () => { f.available = true })
  const retry = await prepareAssistantRuntime('two', new AbortController().signal)
  await expect(retry.commit()).resolves.toBeUndefined()
  await retry.dispose()
  expect(await readFile(launcher(), 'utf8')).toBe('prepared ' + path.join(f.root, 'prepared', 'two', 'runtime'))
})
