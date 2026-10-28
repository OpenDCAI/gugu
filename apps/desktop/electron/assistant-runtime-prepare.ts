import { link, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { agentProgramsOf, type DependencyId } from '@gugu/session-core/deps/runtime'
import { getDependencyManager } from './session/main/core/dependencies/dependency-managers'
import { getPlugin } from './session/main/core/agents/plugin-registry'
import { managedAgentPrefix, managedMiseBinDir } from './session/main/core/dependencies/managed-agent-home'
import { runMiseOperation } from './session/main/core/dependencies/mise-installer'
import { AgentInstallFailedError } from './session/main/core/agents/ensure-agent-installed'

export type PreparedAssistantRuntime = { commit(): Promise<void>; dispose(): Promise<void> }

export function discardAssistantPreparation(id: string): Promise<void> {
  return rm(path.join(managedAgentPrefix(), 'prepared', id), { recursive: true, force: true })
}

/** Download, unpack and verify in an operation-owned tree. Existing launchers,
 * shared mise config and installations are never modified by preparation. */
export async function prepareAssistantRuntime(id: string, signal: AbortSignal): Promise<PreparedAssistantRuntime> {
  const root = path.join(managedAgentPrefix(), 'prepared', id)
  const launcherDir = path.join(root, 'entrypoints')
  const manager = await getDependencyManager()
  const prepared: Array<{ dependency: DependencyId; launcher: string }> = []
  let published = false
  try {
    for (const part of agentProgramsOf(getPlugin('claude'))) {
      const dependency = part.dependencyId as DependencyId
      await manager.probe(dependency)
      signal.throwIfAborted()
      if (manager.get(dependency)?.status === 'available') continue
      const choices = manager.getInstallOptions(dependency)
      const option = choices.find(choice => choice.recommended) ?? choices[0]
      if (option?.target?.kind !== 'mise') throw new Error('The assistant runtime has no supported installer on this computer')
      const result = await runMiseOperation({ mise: { target: option.target, operation: 'install', registry: option.registry }, signal },
        { root: path.join(root, 'runtime'), launcherDir })
      if (!result.success) throw new AgentInstallFailedError('claude', result.error)
      prepared.push({ dependency, launcher: option.target.binary + (process.platform === 'win32' ? '.cmd' : '') })
    }
    signal.throwIfAborted()
    return {
      async commit() {
        if (!prepared.length) return
        await mkdir(managedMiseBinDir(), { recursive: true })
        for (const { dependency, launcher } of prepared) {
          // Another installer may have completed while we prepared. Re-probe
          // before publication; never replace an already usable runtime.
          await manager.probe(dependency)
          if (manager.get(dependency)?.status === 'available') continue
          // Atomic, exclusive publication preserves a concurrent install.
          try { await link(path.join(launcherDir, launcher), path.join(managedMiseBinDir(), launcher)) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            await manager.probe(dependency)
            if (manager.get(dependency)?.status === 'available') continue
            throw error
          }
          published = true
        }
        for (const { dependency } of prepared) {
          await manager.probe(dependency)
          if (manager.get(dependency)?.status !== 'available') throw new Error('The prepared assistant runtime could not be started')
        }
      },
      async dispose() {
        // Published launchers refer into this immutable tree. Keep their runtime;
        // a cancelled preparation owns the entire tree and can remove all of it.
        if (!published) await rm(root, { recursive: true, force: true })
        else {
          await rm(launcherDir, { recursive: true, force: true })
          await rm(path.join(root, 'runtime', 'cache'), { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try { await rm(root, { recursive: true, force: true }) }
    catch (cause) { throw Object.assign(new Error('Assistant preparation cleanup failed', { cause }), { code: 'assistant_preparation_cleanup_failed' }) }
    throw error
  }
}
