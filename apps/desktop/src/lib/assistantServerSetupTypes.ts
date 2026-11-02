import type { PrepareLocalHomeResult } from './assistantHomeIpc'

export type AssistantServerErrorCode =
  | 'target_offline' | 'target_unreachable' | 'target_not_owned' | 'account_changed'
  | 'unsupported_platform' | 'unsupported_arch' | 'server_update_required'
  | 'assistant_exists' | 'preparation_busy' | 'runtime_failed' | 'workspace_failed'
  | 'interrupted' | 'model_unavailable' | 'preparation_not_found' | 'input_mismatch'
  | 'provision_failed' | 'cleanup_failed'
export type AssistantServerFailure = {
  code: AssistantServerErrorCode
  retryable: boolean
  next: 'reconnect_target' | 'sign_in' | 'choose_target' | 'update_server' | 'open_assistant'
    | 'resume' | 'retry' | 'configure_target_model' | 'review' | 'retry_cleanup'
}
export type AssistantServerReply<T> = { ok: true; value: T } | { ok: false; error: AssistantServerFailure }
export type AssistantServerBinding = { ownerUserId: string; deviceId: string }
export type AssistantServerOperation = AssistantServerBinding & { operationId: string }
export type AssistantServerStart = AssistantServerOperation & { ownerProfile: string }
export type AssistantServerPreparationPhase = 'checking' | 'runtime' | 'workspace' | 'prepared' | 'cancelling' | 'cancelled' | 'failed'
export type AssistantServerPreparation = {
  operationId: string
  phase: AssistantServerPreparationPhase
  cancellable: boolean
  installationStarted: boolean
  error?: AssistantServerFailure
  home?: PrepareLocalHomeResult
}
export type AssistantServerSetupProgress = {
  phase: Exclude<AssistantServerPreparationPhase, 'prepared'> | 'creating' | 'starting' | 'ready'
  cancellable: boolean
  error?: AssistantServerFailure
}
export type AssistantServerPreflight = {
  version: 1
  deviceId: string
  modelSource: 'platform' | 'target'
  defaultModel: string | null
}

export function assistantServerFailure(code: AssistantServerErrorCode): AssistantServerFailure {
  const next: AssistantServerFailure['next'] =
    code === 'target_offline' || code === 'target_unreachable' ? 'reconnect_target'
      : code === 'account_changed' || code === 'target_not_owned' ? 'sign_in'
        : code === 'unsupported_platform' || code === 'unsupported_arch' ? 'choose_target'
          : code === 'server_update_required' ? 'update_server'
            : code === 'assistant_exists' ? 'open_assistant'
              : code === 'preparation_busy' ? 'resume'
                : code === 'model_unavailable' ? 'configure_target_model'
                  : code === 'cleanup_failed' ? 'retry_cleanup'
                    : code === 'preparation_not_found' || code === 'input_mismatch' ? 'review' : 'retry'
  return { code, next, retryable: next === 'retry' || next === 'retry_cleanup' || next === 'reconnect_target' }
}

export class AssistantServerSetupError extends Error {
  readonly code: AssistantServerErrorCode
  readonly retryable: boolean
  readonly next: AssistantServerFailure['next']
  constructor(failure: AssistantServerFailure, options?: ErrorOptions) {
    super(`Assistant server setup: ${failure.code}`, options)
    this.name = 'AssistantServerSetupError'
    this.code = failure.code
    this.retryable = failure.retryable
    this.next = failure.next
  }
}
