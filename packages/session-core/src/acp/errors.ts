/**
 * Tagged error union for AcpRuntime public API failures.
 */

import type { BaseError, SerializedError } from '@gugu/session-shared';
import { fail } from '@gugu/session-shared';

/** Provider does not support the ACP transport. */
export type ProviderUnsupportedError = BaseError<'provider_unsupported'>;

/** No conversation with the given id is tracked in the runtime. */
export type SessionNotFoundError = BaseError<'conversation_not_found'>;

/**
 * A command was issued but the current lifecycle state does not allow it,
 * e.g. Prompt while already working.
 */
export type InvalidStateError = BaseError<'invalid_state'>;

/**
 * A decline-if-busy prompt met a busy session. The verdict is atomic and the bytes entered no
 * buffer — the channel's own "not now", produced inside the single-threaded machine decide, so the
 * caller can retry at a later delivery point without ever double-injecting (delivery-routing S2b).
 */
export type SessionBusyError = BaseError<'session_busy'>;

/** Spawning the agent process failed. */
export type SpawnFailedError = BaseError<'spawn_failed', SerializedError>;

/** The ACP initialize handshake failed. */
export type InitializeFailedError = BaseError<'initialize_failed', SerializedError>;

/** The agent's newSession call failed. */
export type NewSessionFailedError = BaseError<'new_session_failed', SerializedError>;

/** The agent requires authentication before a session can be started. */
export type AuthRequiredError = BaseError<'auth_required', SerializedError>;

/** The saved provider-native session no longer exists and cannot be resumed. */
export type ProviderSessionMissingError = BaseError<'provider_session_missing', SerializedError>;

/** A prompt() call to the agent failed. */
export type PromptFailedError = BaseError<'prompt_failed', SerializedError>;

/** A cancel() call to the agent failed. */
export type CancelFailedError = BaseError<'cancel_failed', SerializedError>;

/** Closing an ACP session or releasing its process failed. */
export type StopFailedError = BaseError<'stop_failed', SerializedError>;
/** Termination was requested but the bound process has not exited. */
export type StopPendingError = BaseError<'stop_pending'>;

/** 停某个后台任务(#5117)的请求没送到/被适配器拒了 —— 与 stop_failed(停整个会话)是两件事。 */
export type StopTaskFailedError = BaseError<'stop_task_failed', SerializedError>;

/** A setSessionConfigOption() call to the agent failed. */
export type SetConfigFailedError = BaseError<'set_config_failed', SerializedError>;

/** A setSessionMode() call to the agent failed. */
export type SetModeFailedError = BaseError<'set_mode_failed', SerializedError>;

export type AcpRuntimeError =
  | ProviderUnsupportedError
  | SessionNotFoundError
  | InvalidStateError
  | SessionBusyError
  | SpawnFailedError
  | InitializeFailedError
  | NewSessionFailedError
  | AuthRequiredError
  | ProviderSessionMissingError
  | PromptFailedError
  | CancelFailedError
  | StopFailedError
  | StopTaskFailedError
  | SetConfigFailedError
  | SetModeFailedError;

export type AcpStartSessionError =
  | ProviderUnsupportedError
  | AuthRequiredError
  | SpawnFailedError
  | InitializeFailedError
  | NewSessionFailedError
  | ProviderSessionMissingError
  | SetConfigFailedError
  | InvalidStateError;
export type AcpResumeSessionError = AcpStartSessionError;
export type AcpStopSessionError = StopFailedError | StopPendingError;
export type AcpSendPromptError =
  | SessionNotFoundError
  | InvalidStateError
  | SessionBusyError
  | PromptFailedError;
export type AcpQueuePromptError = SessionNotFoundError | InvalidStateError;
export type AcpEditQueuedPromptError = AcpQueuePromptError;
export type AcpDeleteQueuedPromptError = AcpQueuePromptError;
export type AcpChangeQueuePromptOrderError = AcpQueuePromptError;
export type AcpSteerQueuedPromptError = AcpSendPromptError;
export type AcpResolvePermissionError = AcpQueuePromptError;
export type AcpSetPromptDraftError = SessionNotFoundError;
export type AcpCancelTurnError = InvalidStateError | CancelFailedError;
export type AcpStopBackgroundTaskError =
  | SessionNotFoundError
  | InvalidStateError
  | StopTaskFailedError;
export type AcpSetModelOptionError =
  | SessionNotFoundError
  | InvalidStateError
  | SetConfigFailedError;
export type AcpSetModeOptionError =
  | SessionNotFoundError
  | InvalidStateError
  | SetModeFailedError;
export type AcpExportTranscriptError = SessionNotFoundError;
export type AcpExportRawLogError = SessionNotFoundError;
export type AcpAttachmentError = InvalidStateError;
export type AcpGetHistoryError = never;

export const acpErr = {
  providerUnsupported: (providerId: string) =>
    fail('provider_unsupported', { message: `Provider '${providerId}' does not support ACP` }),

  sessionNotFound: (sessionId: string) =>
    fail('conversation_not_found', { message: sessionId }),

  invalidState: (message: string) => fail('invalid_state', { message }),

  sessionBusy: (message: string) => fail('session_busy', { message }),

  spawnFailed: (cause: SerializedError) => fail('spawn_failed', { cause }),

  initializeFailed: (cause: SerializedError) => fail('initialize_failed', { cause }),

  newSessionFailed: (cause: SerializedError) => fail('new_session_failed', { cause }),

  authRequired: (cause: SerializedError) => fail('auth_required', { cause }),

  providerSessionMissing: (cause: SerializedError) => fail('provider_session_missing', { cause }),

  promptFailed: (cause: SerializedError) => fail('prompt_failed', { cause }),

  cancelFailed: (cause: SerializedError) => fail('cancel_failed', { cause }),

  stopFailed: (cause: SerializedError) => fail('stop_failed', { cause }),
  stopPending: () => fail('stop_pending'),

  stopTaskFailed: (cause: SerializedError) => fail('stop_task_failed', { cause }),

  setConfigFailed: (cause: SerializedError) => fail('set_config_failed', { cause }),

  /**
   * The model chosen for a session before it existed cannot be applied on the live provider
   * connection (no model dimension exposed, or the id rejected). A start failure, never a warning:
   * proceeding would run the session on whatever the provider defaulted to while the product keeps
   * showing the chosen model, and the transcript gives the user no way to notice (#5047). The
   * provider's own reason stays verbatim in `cause`; the message names the model so the surface can
   * show both without reconstructing them.
   */
  initialModelUnappliable: (providerId: string, model: string, cause: SerializedError) =>
    fail('set_config_failed', {
      message: `Provider '${providerId}' cannot apply the selected model '${model}': ${cause.message}`,
      cause,
    }),

  setModeFailed: (cause: SerializedError) => fail('set_mode_failed', { cause }),
} as const;
