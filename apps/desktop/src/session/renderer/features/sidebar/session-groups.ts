import { isNeedsYou, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';

// @@@sessionpage otty-state — sidebar status groups (spec session-page「会话列表与状态」): conversations
// hang directly under their project, bucketed by the same presentation as the agent avatar.
// The sections are the shared model's sidebar projection: needs-you = needs_user only.
// Errors keep their red row status without asking for input. Idle/stateless
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
  if (isNeedsYou(presentation)) return 'needs-you';
  switch (presentation?.tone) {
    case 'running':
    case 'parked':
      return 'working';
    default:
      return null;
  }
}
