import { defineEvent } from '@shared/lib/ipc/events';

export type AgentEventType =
  | 'notification'
  | 'stop'
  | 'error'
  | 'start'
  /** The agent started waiting on the user for something only they can give (see `payload.waitKind`). */
  | 'wait'
  /** A wait the harness reported has been answered (`payload.waitId`, or every open wait when absent). */
  | 'wait_resolved'
  /** Snapshot of the self-driving work the harness reports outside a turn edge (ACP background agents). */
  | 'background';

// spec agent-status-vocabulary —— 状态词表只在 core 定义一次,这里只是转出。
import type { AgentWaitKind } from '@gugu/core/shared/agentStatus';
export type {
  AgentBackgroundWork,
  AgentStatus,
  AgentStatusDetail,
  AgentStatusReading,
  AgentWaitKind,
} from '@gugu/core/shared/agentStatus';

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success';

export interface AgentEvent {
  type: AgentEventType;
  /** Set only for hook-delivered events: which spawn's token carried it. */
  sourceId?: string;
  providerId?: string;
  projectId: string;
  sessionId: string;
  timestamp: number;
  payload: {
    notificationType?: NotificationType;
    message?: string;
    lastAssistantMessage?: string;
    /** `stop` / `background`: background tasks still doing work (see CanonicalHookEvent). */
    backgroundTasks?: number;
    /** `stop` / `background`: scheduled self wake-ups still pending (/loop, cron). */
    scheduledTasks?: number;
    /** `stop` only: the turn was interrupted rather than finished. Absent = finished. */
    outcome?: 'cancelled';
    /** `wait` only: what the agent waits on. */
    waitKind?: AgentWaitKind;
    /** `wait` / `wait_resolved`: the harness's own id for that wait, when it has one. */
    waitId?: string;
    /** #6264 这一轮因登录被拒而结束(见 CanonicalHookEvent 同名一格)。 */
    signInRequired?: boolean;
    /** The edge belongs to a subagent the session spawned (see CanonicalHookEvent). */
    origin?: 'subagent';
  };
}

/** A provider's capabilities on this machine changed after boot (an ACP handshake's fork reading); re-read agents. */
export const agentCapabilitiesChangedChannel = defineEvent<{ providerId: string }>('agent:capabilities-changed');
