import { isNeedsYou, presentationAttention, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';

// @@@sessionpage otty-state — sidebar status groups (spec session-page「会话列表与状态」): conversations
// hang directly under their project, bucketed by the same presentation as the agent avatar.
// The sections are the shared model's sidebar projection: needs-you = waits and failures.
// Errors retain their red row status within Needs you. Grouping reads the raw state, not the read bit:
// opening a row must not move it mid-click. Counts are read-gated (isNeedsYou). Idle/stateless
// conversations get NO section label — they sit flat below, newest first. Grouping always uses the
// root's presentation; unread emphasis does not move a family between sections.
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

/** Map the shared presentation to its sidebar section; null = idle (flat, unlabelled). */
export function sidebarStateGroup(presentation: AgentStatusPresentation | null): SidebarStateGroup | null {
  if (presentationAttention(presentation) !== null) return 'needs-you';
  switch (presentation?.tone) {
    case 'running':
    case 'parked':
      return 'working';
    default:
      return null;
  }
}

/** One conversation as the project needs-you count reads it. */
export type NeedsYouCountEntry = { presentation?: AgentStatusPresentation | null; unseen: boolean; hostOnline?: boolean };

/**
 * A project's needs-you count: the desktop project dot and the phone project-group avatar badge read this one rule —
 * waits and unread failures (isNeedsYou) on hosts that are reachable.
 */
export function needsYouCount(entries: readonly NeedsYouCountEntry[]): number {
  return entries.filter((entry) => isNeedsYou(entry.presentation, entry.unseen) && entry.hostOnline !== false).length;
}
