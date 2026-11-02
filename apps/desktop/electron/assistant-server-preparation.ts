import type { PreparedAssistantRuntime } from './assistant-runtime-prepare'
import type { PrepareLocalHomeResult, WipeLocalHomeResult } from '../src/lib/assistantHomeIpc'
import {
  AssistantServerSetupError, assistantServerFailure,
  type AssistantServerStart, type AssistantServerPreparation, type AssistantServerOperation,
} from '../src/lib/assistantServerSetupTypes'

export type ServerPreparationRecord = AssistantServerStart & {
  version: 1
  attempt: number
  freshCleared: boolean
  state: AssistantServerPreparation
}

/** One account host owns the journal and the cancellation/write fence. No renderer
 * lifetime is involved; reconnecting clients query the same operation. */
export function createAssistantServerPreparation(deps: {
  read(): Promise<ServerPreparationRecord | null>
  write(record: ServerPreparationRecord): Promise<void>
  validate(input: AssistantServerOperation, starting: boolean): Promise<void>
  retired(input: AssistantServerOperation): Promise<boolean>
  prepare(id: string, signal: AbortSignal): Promise<PreparedAssistantRuntime>
  cleanup(id: string, keepRuntime: boolean): Promise<void>
  wipe(): Promise<WipeLocalHomeResult>
  install(ownerProfile: string): Promise<PrepareLocalHomeResult>
  log(error: unknown, operationId: string): void
}) {
  let journal: ServerPreparationRecord | null = null
  let loaded = false
  let active: { id: string; abort: AbortController; work: Promise<void> } | null = null
  let queue = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn)
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  const fail = (code: Parameters<typeof assistantServerFailure>[0]): never => { throw new AssistantServerSetupError(assistantServerFailure(code)) }
  const save = async (record: ServerPreparationRecord, state: AssistantServerPreparation) => {
    await deps.write({ ...record, state })
    record.state = state
  }
  async function load() {
    if (loaded) return
    journal = await deps.read()
    if (journal && !['prepared', 'failed', 'cancelled'].includes(journal.state.phase)) {
      await save(journal, { ...journal.state, phase: 'failed', cancellable: !journal.state.installationStarted, error: assistantServerFailure('interrupted') })
    }
    loaded = true
  }
  async function requireRecord(input: AssistantServerOperation) {
    await deps.validate(input, false)
    await load()
    if (!journal || journal.operationId !== input.operationId) return fail('preparation_not_found')
    if (journal.ownerUserId !== input.ownerUserId || journal.deviceId !== input.deviceId) return fail('target_not_owned')
    return journal
  }
  async function run(record: ServerPreparationRecord, abort: AbortController) {
    let runtime: PreparedAssistantRuntime | undefined
    try {
      await save(record, { ...record.state, phase: 'runtime' })
      runtime = await deps.prepare(`${record.operationId}-${record.attempt}`, abort.signal)
      abort.signal.throwIfAborted()
      // Synchronous admission fence: cancel cannot succeed after launcher/home writes start.
      record.state = { ...record.state, phase: 'workspace', installationStarted: true, cancellable: false }
      await deps.write(record)
      await deps.validate(record, true)
      await runtime.commit()
      if (!record.freshCleared) {
        await deps.wipe()
        record.freshCleared = true
        await deps.write(record)
      }
      const home = await deps.install(record.ownerProfile)
      await runtime.dispose()
      runtime = undefined
      await save(record, { ...record.state, phase: 'prepared', home })
    } catch (error) {
      deps.log(error, record.operationId)
      let cleanupFailed = false
      try { await runtime?.dispose() } catch (cleanup) { cleanupFailed = true; deps.log(cleanup, record.operationId) }
      const code = cleanupFailed || (error as { code?: string })?.code === 'assistant_preparation_cleanup_failed' ? 'cleanup_failed'
        : error instanceof AssistantServerSetupError ? error.code
          : record.state.installationStarted ? 'workspace_failed' : 'runtime_failed'
      await save(record, { ...record.state, phase: 'failed', error: assistantServerFailure(code) })
    }
  }
  return {
    assertProvision(operationId: string) {
      return serial(async () => {
        await load()
        if (!journal || journal.operationId !== operationId) return fail('input_mismatch')
        if (active || !['prepared', 'cancelled'].includes(journal.state.phase)) return fail('preparation_busy')
      })
    },
    closeHome(operationId: string) {
      return serial(async () => {
        await load()
        if (!journal || journal.operationId !== operationId) return fail('input_mismatch')
        if (active) return fail('preparation_busy')
        // One serial transaction with start: a late close cannot wipe a newly
        // prepared home after an earlier close already completed.
        const result = await deps.wipe()
        await save(journal, { ...journal.state, phase: 'cancelled', cancellable: false })
        return result
      })
    },
    start(input: AssistantServerStart) {
      return serial(async () => {
        await deps.validate(input, true)
        await load()
        if (journal && journal.operationId !== input.operationId && journal.state.phase !== 'cancelled') {
          // A governed-removed identity is authoritative retirement evidence.
          // This also lets a fresh setup finish cleanup after an interrupted close.
          if (active || !await deps.retired(journal)) return fail('preparation_busy')
        }
        if (journal?.operationId === input.operationId) {
          if (journal.ownerUserId !== input.ownerUserId || journal.deviceId !== input.deviceId || journal.ownerProfile !== input.ownerProfile) return fail('input_mismatch')
          if (active || journal.state.phase === 'prepared' || journal.state.phase === 'cancelled') return { ...journal.state }
          if (journal.state.error?.code === 'cleanup_failed') {
            try { await deps.cleanup(`${journal.operationId}-${journal.attempt}`, journal.state.installationStarted) }
            catch (error) { deps.log(error, journal.operationId); return fail('cleanup_failed') }
          }
        }
        const record: ServerPreparationRecord = journal?.operationId === input.operationId ? journal : {
          ...input, version: 1, attempt: 0, freshCleared: false,
          state: { operationId: input.operationId, phase: 'checking', cancellable: true, installationStarted: false },
        }
        record.attempt += 1
        await save(record, { operationId: input.operationId, phase: 'checking', cancellable: !record.state.installationStarted, installationStarted: record.state.installationStarted })
        journal = record
        const abort = new AbortController()
        // The state and active handle are installed before the background work can finish.
        const task = { id: input.operationId, abort, work: Promise.resolve() }
        active = task
        task.work = Promise.resolve().then(() => run(record, abort)).finally(() => { if (active === task) active = null })
        // Keep a rejected journal write observable on the next query, and in host logs.
        void task.work.catch(error => deps.log(error, input.operationId))
        return { ...record.state }
      })
    },
    status(input: AssistantServerOperation) {
      return serial(async () => {
        const record = await requireRecord(input)
        if (!active && !['prepared', 'failed', 'cancelled'].includes(record.state.phase)) {
          await save(record, { ...record.state, phase: 'failed', error: assistantServerFailure('interrupted') })
        }
        return { ...record.state }
      })
    },
    cancel(input: AssistantServerOperation) {
      return serial(async () => {
        const record = await requireRecord(input)
        if (record.state.installationStarted) return { cancelled: false, state: { ...record.state } }
        if (record.state.phase === 'cancelled') return { cancelled: true, state: { ...record.state } }
        active?.abort.abort(new Error('Assistant preparation cancelled'))
        await active?.work
        if (record.state.error?.code === 'cleanup_failed') {
          try { await deps.cleanup(`${record.operationId}-${record.attempt}`, false) }
          catch (error) { deps.log(error, record.operationId); return fail('cleanup_failed') }
        }
        await save(record, { operationId: record.operationId, phase: 'cancelled', installationStarted: false, cancellable: false })
        return { cancelled: true, state: { ...record.state } }
      })
    },
  }
}
