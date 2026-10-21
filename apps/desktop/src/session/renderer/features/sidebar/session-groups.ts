import { sessionReading } from '@/mobile/agent-watch/watch-status';
import type { AgentStatusView } from '@gugu/core/shared/agentStatus';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { type AgentStatus } from '@shared/core/agents/agentEvents';

// @@@sessionpage otty-state — sidebar status groups (spec session-page「会话列表与状态」): conversations
// hang directly under their project, with each tree bucketed by its root's raw agent status.
// The sections are the six-state model's sidebar projection: needs-you = Needs input + Failed
// (needs_user / error — everything waiting on a human). Idle/stateless
// conversations get NO section label — they sit flat below, newest first. Grouping always uses the
// root's raw status (never the seen-gated one) so opening a conversation doesn't reshuffle its family.
export type SidebarStateGroup = 'needs-you' | 'working';

// Render order, top → bottom. "Needs you" first so blocked work surfaces at a glance.
export const SIDEBAR_STATE_GROUP_ORDER: readonly SidebarStateGroup[] = [
  'needs-you',
  'working',
];

export interface SidebarStateGroupMeta {
  /** Text-color class for the header label — the same `--agent-tone-*` the cells in the group use (#6448 table). */
  className: string;
}

export const SIDEBAR_STATE_GROUP_META: Record<SidebarStateGroup, SidebarStateGroupMeta> = {
  'needs-you': { className: 'text-[var(--agent-tone-needs-user)]' },
  working: { className: 'text-foreground' },
};

/** Map a raw conversation status to its sidebar section; null = idle (flat, unlabelled). */
export function sidebarStateGroup(status: AgentStatus | null): SidebarStateGroup | null {
  switch (status) {
    case 'needs_user':
    case 'error':
      return 'needs-you';
    case 'working':
      return 'working';
    default:
      return null;
  }
}

/**
 * #6264 别的机器上的会话:那台机器报上来的读数,与手机同一种读法(watch-status 的 `sessionReading`:新宿主的
 * `status`,老宿主退回旧词),之后分组、行尾指示与本机会话走同一套。
 *
 * 机器离线时「在跑 / 后台在跑」熬不过关机 —— 它描述的是此刻,而此刻那台机器关着(watch-status 的
 * sessionPresentation 同一条口径)。这时返回 null = 状态未知:不进「运行中」、行尾不转圈,
 * ❌ 也不改口说「空闲」(那同样是在替一台联系不上的机器打包票)。「需要你」「出错」「做完了」熬得过关机,照报。
 */
export function remoteAgentStatus(
  session: Pick<SessionpageSessionSummary, 'conversationId' | 'status' | 'agentStatus'>,
  online: boolean,
): AgentStatusView | null {
  const reading = sessionReading(session);
  if (reading?.status === 'working' && !online) return null;
  return reading;
}
