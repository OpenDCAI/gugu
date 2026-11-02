import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HostDependencyManager } from '../../../../packages/session-core/src/host-dependencies/runtime/host-dependency-manager'
import { NodeExecutionContext } from '../../../../packages/session-core/src/exec/node-execution-context'

const f = vi.hoisted(() => ({ root: '', manager: null as HostDependencyManager | null, install: vi.fn() }))
vi.mock('@gugu/session-core/deps/runtime', () => ({ agentProgramsOf: () => [{ dependencyId: 'assistant-fixture-935' }] }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/plugin-registry', () => ({ getPlugin: () => ({}) }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/managed-agent-home', () => ({
  managedAgentPrefix: () => f.root,
  managedMiseBinDir: () => path.join(f.root, 'mise-bin'),
  agentBinDirsInPriorityOrder: () => [path.join(f.root, 'mise-bin')], vendorInstallDirs: () => [],
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/mise-installer', () => ({ runMiseOperation: f.install }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/ensure-agent-installed', () => ({ AgentInstallFailedError: Error }))
vi.mock('../../../../apps/desktop/electron/session/main/core/dependencies/dependency-managers', () => ({ getDependencyManager: async () => f.manager }))
const { prepareAssistantRuntime } = await import('../../../../apps/desktop/electron/assistant-runtime-prepare')
const { ensureUserBinDirsInPath } = await import('../../../../apps/desktop/electron/session/main/utils/userEnv')

afterEach(async () => { vi.unstubAllEnvs(); if (f.root) await rm(f.root, { recursive: true, force: true }) })

it('finds the first published runtime when mise-bin did not exist at startup (all platforms)', async () => {
  f.root = await mkdtemp(path.join(os.tmpdir(), 'assistant-fresh-935-'))
  vi.stubEnv('GUGU_HOME', path.join(f.root, 'home'))
  vi.stubEnv('GUGU_USER_DATA_DIR', path.join(f.root, 'user-data'))
  const bin = path.join(f.root, 'mise-bin')
  vi.stubEnv('PATH', process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin')
  expect(ensureUserBinDirsInPath()).toEqual([])
  expect(process.env.PATH!.split(path.delimiter)).not.toContain(bin)
  const command = 'assistant-fixture-935'
  const target = { kind: 'mise' as const, binary: command, package: 'test', backend: { kind: 'platform-archive' as const, executables: {} } }
  const option = { method: 'mise' as const, recommended: true, command: 'fixture install', target }
  f.manager = new HostDependencyManager(new NodeExecutionContext(), { dependencies: [{
    id: command, category: 'agent', commands: [command], name: 'Assistant fixture',
    installCommands: { macos: [option], linux: [option], windows: [option] },
  }] })
  f.install.mockImplementation(async (_operation, paths) => {
    await mkdir(paths.launcherDir, { recursive: true })
    const file = path.join(paths.launcherDir, command + (process.platform === 'win32' ? '.cmd' : ''))
    await writeFile(file, process.platform === 'win32'
      ? '@echo off\r\necho 2.1.316 (Claude Code)\r\n'
      : '#!/bin/sh\nprintf "2.1.316 (Claude Code)\\n"\n')
    await chmod(file, 0o755)
    return { success: true }
  })
  const prepared = await prepareAssistantRuntime('fresh', new AbortController().signal)
  await prepared.commit()
  expect(process.env.PATH!.split(path.delimiter)[0]).toBe(bin)
  expect(f.manager.get(command)).toMatchObject({ status: 'available', version: '2.1.316' })
  await prepared.dispose()
})
