import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ root: '', available: false, unusable: false, probe: vi.fn(), install: vi.fn() }))
vi.mock('@gugu/session-core/deps/runtime', () => ({ agentProgramsOf: () => [{ dependencyId: 'claude-code' }] }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/plugin-registry', () => ({ getPlugin: () => ({}) }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/managed-agent-home', () => ({
  managedAgentPrefix: () => f.root, managedMiseBinDir: () => path.join(f.root, 'bin'),
}))
vi.mock('../../../../apps/desktop/electron/session/main/utils/userEnv', () => ({ ensureUserBinDirsInPath: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/mise-installer', () => ({ runMiseOperation: f.install }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/ensure-agent-installed', () => ({ AgentInstallFailedError: Error }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/dependency-managers', () => ({ getDependencyManager: async () => ({
  probe: f.probe, get: () => ({ status: f.available ? 'available' : 'missing' }),
  getInstallOptions: () => [{ recommended: true, target: { kind: 'mise', binary: 'claude' } }],
}) }))
const { prepareAssistantRuntime } = await import('../../../../apps/desktop/electron/assistant-runtime-prepare')
const launcher = () => path.join(f.root, 'bin', 'claude' + (process.platform === 'win32' ? '.cmd' : ''))
const prepare = (id: string) => prepareAssistantRuntime(id, new AbortController().signal)
beforeEach(async () => {
  vi.resetAllMocks(); f.available = false; f.unusable = false
  f.root = await mkdtemp(path.join(os.tmpdir(), 'assistant-runtime-'))
  f.probe.mockImplementation(async () => {
    const content = await readFile(launcher(), 'utf8').catch(() => '')
    f.available = !f.unusable && /^(prepared|usable)/.test(content)
  })
  f.install.mockImplementation(async (_operation, paths) => {
    await mkdir(paths.launcherDir, { recursive: true })
    await writeFile(path.join(paths.launcherDir, path.basename(launcher())), 'prepared@' + path.basename(path.dirname(paths.launcherDir)))
    return { success: true }
  })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(f.root, { recursive: true, force: true }) })

it('atomically replaces an existing unusable launcher', async () => {
  await mkdir(path.dirname(launcher()), { recursive: true })
  await writeFile(launcher(), 'broken launcher')
  const prepared = await prepare('one')
  await prepared.commit()
  await prepared.dispose()
  expect(await readFile(launcher(), 'utf8')).toBe('prepared@one')
})

it('keeps an installation that became usable while preparing', async () => {
  const prepared = await prepare('one')
  await mkdir(path.dirname(launcher()), { recursive: true })
  await writeFile(launcher(), 'usable concurrent runtime')
  await prepared.commit()
  await prepared.dispose()
  expect(await readFile(launcher(), 'utf8')).toBe('usable concurrent runtime')
  await expect(readFile(path.join(f.root, 'prepared/one/entrypoints', path.basename(launcher())))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rolls back its failed publication so the next attempt can succeed', async () => {
  const prepared = await prepare('first')
  f.unusable = true
  await expect(prepared.commit()).rejects.toThrow('could not be started')
  await expect(readFile(launcher())).rejects.toMatchObject({ code: 'ENOENT' })
  await prepared.dispose()
  f.unusable = false
  const retry = await prepare('retry')
  await retry.commit()
  await retry.dispose()
  expect(await readFile(launcher(), 'utf8')).toBe('prepared@retry')
})

it('does not roll back a launcher replaced by another publisher', async () => {
  const prepared = await prepare('one')
  f.probe.mockImplementation(async () => {
    if ((await readFile(launcher(), 'utf8').catch(() => '')).startsWith('prepared')) {
      await writeFile(launcher() + '.other', 'usable other publisher')
      await rename(launcher() + '.other', launcher())
    }
    f.available = false
  })
  await expect(prepared.commit()).rejects.toThrow('could not be started')
  await prepared.dispose()
  expect(await readFile(launcher(), 'utf8')).toBe('usable other publisher')
})

it('serializes concurrent preparations and preserves the first usable publication', async () => {
  const [one, two] = await Promise.all([prepare('one'), prepare('two')])
  await Promise.all([one.commit(), two.commit()])
  await Promise.all([one.dispose(), two.dispose()])
  expect(['prepared@one', 'prepared@two']).toContain(await readFile(launcher(), 'utf8'))
  expect((await readFile(launcher(), 'utf8')).startsWith('prepared')).toBe(true)
})

it('preserves the original verification failure when the publication lock is lost', async () => {
  const lock = lockfile.lock
  let loseLock!: () => void
  vi.spyOn(lockfile, 'lock').mockImplementationOnce(async (...args) => {
    const release = await lock(...args)
    loseLock = () => args[1]?.onCompromised?.(Object.assign(new Error('lock compromised'), { code: 'ECOMPROMISED' }))
    return async () => { await release(); throw new Error('lock release failed') }
  })
  const prepared = await prepare('one')
  f.probe.mockImplementation(async () => {
    if ((await readFile(launcher(), 'utf8').catch(() => '')).startsWith('prepared')) loseLock()
    f.available = false
  })
  const error = await prepared.commit().then(() => { throw new Error('Expected verification to fail') }, (error: Error & { cause: AggregateError }) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.cause.errors[0].cause.errors[0].message).toContain('could not be started')
  expect(error.cause.errors[0].cause.errors[1].message).toBe('lock compromised')
  expect(error.cause.errors[1].message).toBe('lock release failed')
  await prepared.dispose()
})
