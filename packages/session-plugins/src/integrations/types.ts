/** App-facing connection state for an integration account. */
export type ConnectionStatus =
  | {
      connected: true;
      /** Resolved account identity, e.g. user or workspace name shown in settings. */
      displayName?: string;
      /** Secondary detail, e.g. organization or host when it differs from displayName. */
      displayDetail?: string;
    }
  | {
      connected: false;
      /** Absent when simply not configured; present when verification failed. */
      error?: string;
    };

export type IntegrationError =
  | { type: 'auth_failed'; message: string }
  /**
   * A browser authorization that no longer works and cannot be renewed: the
   * token was rejected, or it ran out and the server issued no refresh token
   * (Dida365). Only connecting again fixes it — product spec
   * 「续不上时」.
   */
  | { type: 'authorization_expired'; message: string }
  | { type: 'rate_limited'; message: string; resetAt?: string }
  | { type: 'not_found_or_no_access'; message: string }
  | { type: 'sso_required'; message: string; ssoUrl?: string }
  | { type: 'host_unreachable'; message: string }
  | { type: 'unsupported_host'; message: string }
  | { type: 'invalid_input'; message: string }
  /**
   * #921 The request did not reach the platform in time (`408 request_timeout`), even after the device sent it a
   * second time by itself. Temporary; the copy never asks the person to retry.
   */
  | { type: 'timed_out'; message: string }
  /** #921 This device could not reach the Gugu platform (no network, or no answer in time). */
  | { type: 'network'; message: string }
  /** #921 a key this device kept from before was rejected on its way to the platform: enter it again. */
  | { type: 'key_rejected'; message: string }
  /**
   * #921 the provider answered but cannot be used right now (quota, QPS, a temporary or unrecognised error): try again
   * later. Temporary: never a reauth, never a reason to drop a key. A network or host failure stays `host_unreachable`.
   */
  | { type: 'provider_unavailable'; message: string }
  | { type: 'generic'; message: string };
