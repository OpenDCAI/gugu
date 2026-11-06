/** Main-process contracts only. Do not expose this service through Agent/MCP/device RPC. */
export type VaultCode = 'LOCKED' | 'UNAVAILABLE' | 'INVALID_INPUT' | 'NOT_INITIALIZED' | 'ALREADY_EXISTS'
  | 'DATA_MISSING' | 'DATA_DAMAGED' | 'WRONG_ACCOUNT' | 'WRONG_INSTALLATION' | 'CANNOT_UNLOCK'
  | 'RECOVERY_INVALID' | 'STALE_REFERENCE' | 'STORAGE_FAILED' | 'AUDIT_FAILED' | 'CANCELLED'
export class VaultError extends Error {
  constructor(readonly code: VaultCode) { super(code); this.name = 'VaultError' }
}
export interface CredentialReference { id: string; version: number; epoch: string }
export interface CredentialSummary { reference: CredentialReference; origin: string; maskedAccount: string }
export type LockReason = 'explicit' | 'os-lock' | 'suspend' | 'logout' | 'account-switch' | 'app-exit' | 'failure'
export interface Invalidation { epoch: string; reason: LockReason | 'edit' | 'delete' | 'recovery'; credentialId?: string }
export interface VaultState { status: 'locked' | 'unlocked' | 'unavailable'; epoch: string; reason?: VaultCode }
export interface AuditInput {
  id: string
  action: 'pre-submit' | 'setup' | 'recovery' | 'unlock' | 'lock' | 'add' | 'edit' | 'delete' | 'request' | 'decision' | 'use' | 'invalidate' | 'clear'
  loginSurfaceId?: string; agentId?: string; sessionId?: string; requestId?: string; useId?: string
  credential?: { id: string; version: number }; origin?: string
  decision?: 'allow-once' | 'reject' | 'cancel' | 'expire'
  source: 'local-person' | 'policy' | 'browser' | 'lifecycle'
  outcome: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'invalidated' | 'completed' | 'failed' | 'uncertain' | 'submitted_unconfirmed' | 'login_confirmed' | 'person_interaction_required'
}
export interface AuditRecord extends AuditInput { id: string; at: string; accountId: string }
export type AuditReceipt = { status: 'recorded'; recordId: string } | {
  status: 'unavailable' | 'uncertain'; code: 'AUDIT_FAILED'; retry: false; retainIsolatedLogin: boolean
}
/** Implemented by the trusted local host, never from tool arguments or a claimed principal. */
export interface VaultKeyProtector {
  verifyPerson(): Promise<void>
  wrap(key: Buffer, binding: string): Promise<string>
  unwrap(wrapped: string, binding: string): Promise<Buffer>
}
export interface VaultDependencies {
  root: string
  /** Stable per userData installation; do not use a cloud account/device token. */
  installationBinding: string
  accountId: string
  assertLocalPerson(context: object): void
  assertOwnedLocalAgent?(context: object): void
  /** Check the actual native-file exclusion before every access, including before mkdir. */
  assertPrivateStorageReady(): Promise<void>
  /** The integrated host supplies actual enforcement/approval/observation readiness. No default allow. */
  assertFeatureReady(): Promise<void>
  keys: VaultKeyProtector
  browser?: VaultBrowserSink
  /** Synchronous revocation first, then wait for browser cleanup before edit/delete success. */
  invalidate(event: Invalidation): Promise<void>
  now?: () => number
}

export type { VaultUseCapability, CredentialUseLease as VaultUseControl } from '../session/main/core/browser/credential-use-contract'
import type { VaultUseCapability, CredentialUseBinding, CredentialUseLease, AuditedCredentialUseLease, CredentialUseCleanup, CredentialLoginOutcome } from '../session/main/core/browser/credential-use-contract'
export type VaultUseBinding = CredentialUseBinding
export type BrowserOutcome = CredentialLoginOutcome
export type VaultSinkControl = AuditedCredentialUseLease
export interface VaultBrowserSink {
  claimCredentialSink(capability: VaultUseCapability, binding: VaultUseBinding): CredentialUseLease
  /** Fixed at trusted host construction, never supplied by an Agent or per-call callback. */
  fillAndSubmit(binding: VaultUseBinding, secrets: { account: Buffer; password: Buffer }, control: VaultSinkControl): Promise<BrowserOutcome>
  /** Cleanup proves clearing only and MUST NOT hand back the isolated surface; only the coordinator can finalize handoff. */
  cleanup(useRef: string): Promise<CredentialUseCleanup>
}
/** Login outcome only. A false retention flag is NOT handback authority; the coordinator checks the complete B state. */
export interface CredentialUseResult { status: BrowserOutcome | 'unavailable'; retry: false; retainIsolatedLogin: boolean }
