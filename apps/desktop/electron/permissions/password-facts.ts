import { anySignal } from '@gugu/core/shared/anySignal'
import { canonicalJson } from './operation'

/** Host-owned generation and live revocation. A boolean or serialized assertion cannot qualify. */
export interface LivePasswordFact<T> {
  readonly value: T
  readonly generation: string
  readonly signal: AbortSignal
  assertCurrent(): void
}
type Code = 'password_permission_unavailable' | 'password_permission_denied' | 'password_target_invalid'
export class PasswordPermissionError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'PasswordPermissionError' }
}
export const passwordUnavailable = () => new PasswordPermissionError('password_permission_unavailable')
const thenable = (value: unknown): value is PromiseLike<unknown> => Boolean(value &&
  (typeof value === 'object' || typeof value === 'function') && 'then' in value)

/** Per-check facts only; no approval, capability or submission state. */
export class PasswordFactWindow {
  private readonly controller = new AbortController()
  private currentSignal: AbortSignal
  private readonly checks: Array<() => void> = []

  constructor(signal: AbortSignal) { this.currentSignal = anySignal([signal, this.controller.signal]) }
  get signal(): AbortSignal { return this.currentSignal }
  fail(): void { this.controller.abort() }
  assertCurrent = (): void => {
    try {
      this.currentSignal.throwIfAborted()
      for (const check of this.checks) check()
      this.currentSignal.throwIfAborted()
    } catch {
      this.fail()
      throw passwordUnavailable()
    }
  }
  bind(check: () => void): void { this.checks.push(check); this.assertCurrent() }

  capture<T>(fact: LivePasswordFact<T>): T {
    if (!fact || typeof fact.generation !== 'string' || !fact.generation.trim()
      || !(fact.signal instanceof AbortSignal) || typeof fact.assertCurrent !== 'function') throw passwordUnavailable()
    const generation = fact.generation, revoked = fact.signal, verify = fact.assertCurrent.bind(fact)
    const value = canonicalJson(fact.value)
    this.currentSignal = anySignal([this.currentSignal, revoked])
    const matches = () => fact.generation === generation && fact.signal === revoked && !revoked.aborted && canonicalJson(fact.value) === value
    this.bind(() => {
      if (!matches()) throw passwordUnavailable()
      const result: unknown = verify()
      if (thenable(result)) { void Promise.resolve(result).catch(() => {}); throw passwordUnavailable() }
      if (result !== undefined || !matches()) throw passwordUnavailable()
    })
    return fact.value
  }

  async read<T>(reader: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertCurrent()
    const signal = this.currentSignal
    // Always observe the reader's promise, including late rejection after cancellation.
    const value = reader(signal)
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(passwordUnavailable())
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([value, cancelled])
      this.assertCurrent()
      return result
    } finally { signal.removeEventListener('abort', abort) }
  }
}
