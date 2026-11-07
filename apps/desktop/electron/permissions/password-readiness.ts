import { PasswordFactWindow, passwordUnavailable, type LivePasswordFact } from './password-facts'

export const PASSWORD_PROTECTIONS = ['private_files', 'encrypted_storage', 'local_person_entry',
  'browser_isolation', 'encrypted_audit', 'password_execution', 'rollout_acceptance'] as const
export type PasswordProtection = typeof PASSWORD_PROTECTIONS[number]
/** Password boundary only. Generic MCP may remain observe-only. No Agent setter is exposed. */
export type PasswordExecutionMode = 'enforce' | 'observe' | 'disabled'
export type PasswordProtectionFacts = Partial<Record<PasswordProtection, LivePasswordFact<'ready'>>>
export interface PasswordInstallation { accountId: string; installationId: string; deviceId: string }
export interface PasswordReadinessReaders {
  readInstallation(signal: AbortSignal): Promise<LivePasswordFact<PasswordInstallation>>
  readMode(host: PasswordInstallation, signal: AbortSignal): Promise<LivePasswordFact<PasswordExecutionMode>>
  readProtections(host: PasswordInstallation, operation: 'save' | 'use', signal: AbortSignal): Promise<PasswordProtectionFacts>
}
export type PasswordAvailability =
  | Readonly<{ status: 'ready'; signal: AbortSignal; assertCurrent(): void }>
  | Readonly<{ status: 'unavailable'; reason: 'password_permission_unavailable' }>

export function requirePasswordProtections(window: PasswordFactWindow, facts: PasswordProtectionFacts): void {
  for (const key of PASSWORD_PROTECTIONS) {
    const fact = facts?.[key]
    if (!fact || window.capture(fact) !== 'ready') throw passwordUnavailable()
  }
}

/** Availability only. Vault person authentication/locking and per-use approval remain mandatory. */
export class PasswordFeatureReadiness {
  private readonly readers: Partial<PasswordReadinessReaders>
  constructor(readers: Partial<PasswordReadinessReaders> = {}) {
    this.readers = Object.freeze({
      readInstallation: readers.readInstallation?.bind(readers),
      readMode: readers.readMode?.bind(readers),
      readProtections: readers.readProtections?.bind(readers),
    })
  }
  async check(operation: 'save' | 'use', signal: AbortSignal): Promise<PasswordAvailability> {
    const window = new PasswordFactWindow(signal)
    try {
      const r = this.readers
      if ((operation !== 'save' && operation !== 'use') || !r.readInstallation || !r.readMode || !r.readProtections) throw passwordUnavailable()
      const host = window.capture(await window.read(s => r.readInstallation!(s)))
      if (!host || [host.accountId, host.installationId, host.deviceId].some(value => typeof value !== 'string' || !value.trim())) throw passwordUnavailable()
      const mode = window.capture(await window.read(s => r.readMode!(host, s)))
      if (mode !== 'enforce') throw passwordUnavailable()
      requirePasswordProtections(window, await window.read(s => r.readProtections!(host, operation, s)))
      window.assertCurrent()
      return Object.freeze({ status: 'ready', signal: window.signal, assertCurrent: window.assertCurrent })
    } catch {
      window.fail()
      return Object.freeze({ status: 'unavailable', reason: 'password_permission_unavailable' })
    }
  }
}
