import { callAccountProcess } from './account-call'
import { VERSION_HANDOFF_CALL } from '../session/main/core/pty/attach/attach-protocol'
import { performance } from 'node:perf_hooks'

export type AccountHandoff = { valid(): boolean; release(): Promise<void>; busy?: true }

/** Reuse the private account socket; this is a current-PID admission fence, not a cached busy flag. */
export async function prepareAccountHandoff(
  account: { dataDir: string; email: string | null },
  expected: { pid: number | undefined } | undefined,
  target: string,
): Promise<AccountHandoff | null> {
  if (!expected?.pid) return null
  const started = performance.now()
  const reply = await callAccountProcess(account, { type: VERSION_HANDOFF_CALL, payload: { target } }, { timeoutMs: 5_000 })
  if (!('reply' in reply)) return null
  let value: { result?: { ready?: unknown; pid?: unknown; target?: unknown; token?: unknown } }
  try { value = JSON.parse(reply.reply.toString()) as typeof value } catch { return null }
  const result = value.result
  if (result?.ready === false && result.pid === expected.pid) return { valid: () => false, release: async () => {}, busy: true }
  if (result?.ready !== true || result.target !== target || typeof result.token !== 'string') return null
  if (result.pid !== expected.pid) {
    await callAccountProcess(account, { type: VERSION_HANDOFF_CALL, payload: { target, release: result.token } }, { timeoutMs: 5_000 })
    return null
  }
  return {
    // Admission stays closed for 60s, covering the supervisor's 30s stop grace.
    // Only a promptly received acknowledgement may begin that stop.
    valid: () => performance.now() - started < 10_000,
    release: async () => {
      await callAccountProcess(account, { type: VERSION_HANDOFF_CALL, payload: { target, release: result.token } }, { timeoutMs: 5_000 })
    },
  }
}
