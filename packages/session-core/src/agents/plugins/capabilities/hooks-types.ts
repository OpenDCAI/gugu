export const HOOK_EVENTS = [
  'notification',
  'stop',
  'session',
  'start',
  'error',
  /** The agent started waiting on the user (see `CanonicalHookEvent.waitKind`). */
  'wait',
  /** A wait the harness reported has been answered. */
  'wait_resolved',
  'tool-use',
  'tool-use-failure',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookRegistration = {
  event: string;
  command: string;
};

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success';

/** What a `wait` waits on (the needs_user sub-state). */
export type HookWaitKind = 'approval' | 'question' | 'plan' | 'dialog';

export const HOOK_WAIT_KINDS: readonly HookWaitKind[] = ['approval', 'question', 'plan', 'dialog'];

/**
 * Normalised hook event produced by a plugin's parseHookEvent method.
 *
 * - kind: 'status'  — maps to an agent lifecycle event (start/stop/error/notification/wait/wait_resolved)
 * - kind: 'session' — carries a provider session id to persist on the conversation
 * - kind: 'ignore'  — event should be silently dropped
 */
export type CanonicalHookEvent =
  | {
      kind: 'status';
      type: 'start' | 'stop' | 'error' | 'notification' | 'wait' | 'wait_resolved';
      notificationType?: NotificationType;
      title?: string;
      message?: string;
      lastAssistantMessage?: string;
      /** `stop` only: background tasks still doing work when the turn ended. Absent = not reported. */
      backgroundTasks?: number;
      /** `stop` only: scheduled self wake-ups still pending (/loop, cron, monitor). Absent = not reported. */
      scheduledTasks?: number;
      /** `stop` only: the turn was interrupted rather than finished (Esc / quit mid-turn). Absent = finished. */
      outcome?: 'cancelled';
      /** `wait` only: what the agent waits on. */
      waitKind?: HookWaitKind;
      /** `wait` / `wait_resolved`: the harness's id for that wait; a `wait_resolved` without one resolves every wait. */
      waitId?: string;
      /**
       * #6264 这一轮因为登录被拒而结束(Claude Code 的 StopFailure `error: authentication_failed`)。
       * 宿主据此把这家标成「登录已失效」—— 与聊天会话的 `outcome.signInRequired` 同一件事,只是从终端这条腿学到。
       */
      signInRequired?: boolean;
      /**
       * The edge belongs to a subagent the session spawned, not to the session's own turn (#6385).
       * Set only when the harness payload itself proves it; such an edge carries no session status.
       */
      origin?: 'subagent';
    }
  | { kind: 'session'; providerSessionId: string }
  | { kind: 'ignore' };
