import type { DesktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS, type LocalAssistantPreparationState, type PrepareLocalHomeInput, type PrepareLocalHomeResult } from './assistantHomeIpc'

function cancelled(): Error { return Object.assign(new Error('Assistant setup cancelled'), { name: 'AbortError' }) }

export class AssistantSetupCleanupError extends Error {
  constructor(readonly retry: () => Promise<void>, cause: unknown) {
    super('Assistant preparation cleanup did not finish', { cause })
    this.name = 'AssistantSetupCleanupError'
  }
}

/** Returning to the location picker waits for main-process cancellation and cleanup. */
export async function prepareLocalAssistantSetup(ipc: DesktopIpc, input: PrepareLocalHomeInput, options: {
  signal?: AbortSignal; onInstalling?: () => void
}): Promise<PrepareLocalHomeResult> {
  if (options.signal?.aborted) throw cancelled()
  const started = await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationStart) as { id: string }
  let installing = false
  const markInstalling = () => { if (!installing) { installing = true; options.onInstalling?.() } }
  const off = ipc.eventOn(ASSISTANT_HOME_CHANNELS.preparationChanged, data => {
    const state = data as LocalAssistantPreparationState & { id: string }
    if (state.id === started.id && (state.phase === 'committing' || state.phase === 'committed')) markInstalling()
  })
  const run = async () => {
    try {
      for (;;) {
        if (options.signal?.aborted && !installing) {
          if (await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationCancel, started.id)) throw cancelled()
          markInstalling()
        }
        const state = await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationStatus, started.id) as LocalAssistantPreparationState
        if (state.phase === 'failed') throw new Error(state.error)
        if (state.phase === 'cancelled') throw cancelled()
        if (state.phase === 'ready') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (options.signal?.aborted && await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationCancel, started.id)) throw cancelled()
      const home = await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationCommit, started.id, input) as PrepareLocalHomeResult
      markInstalling()
      return home
    } catch (error) {
      const state = await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationStatus, started.id).catch(() => null) as LocalAssistantPreparationState | null
      if (state?.phase === 'failed' && state.installationStarted) markInstalling()
      throw error
    } finally { off() }
  }
  const release = async () => { await ipc.invoke(ASSISTANT_HOME_CHANNELS.preparationRelease, started.id) }
  const cleanup = async () => {
    try { await release() }
    catch (cause) { throw new AssistantSetupCleanupError(release, cause) }
  }
  return run().then(async home => { await cleanup(); return home }, async error => { await cleanup(); throw error })
}
