import type { AgentProviderId } from '@gugu/session-plugins/agents';

/**
 * 会话标题的两条纯规则 —— 渲染层与主进程共用(手机端建会话走主进程,标题得与桌面新建面同一个算法)。
 * 从 renderer/features/sessions/session-title-utils.ts 原样搬来,那边 re-export 保持旧 import 可用。
 */
type SessionTitleInput = {
  providerId: AgentProviderId;
  title: string;
};

function capitalizeProviderId(providerId: AgentProviderId): string {
  return `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
}

function parseDefaultTitleIndex(title: string, providerId: AgentProviderId): number | null {
  const match = title.match(new RegExp(`^${providerId} \\(([1-9]\\d*)\\)$`, 'i'));
  if (!match) return null;

  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  if (String(index) !== rawIndex) return null;
  return index;
}

export function nextDefaultSessionTitle(
  providerId: AgentProviderId,
  sessions: SessionTitleInput[]
): string {
  const used = new Set<number>();

  for (const session of sessions) {
    if (session.providerId !== providerId) continue;
    const index = parseDefaultTitleIndex(session.title, providerId);
    if (index !== null) used.add(index);
  }

  let next = 1;
  while (used.has(next)) next += 1;

  return `${capitalizeProviderId(providerId)} (${next})`;
}

/**
 * @@@sessionpage layout — derive a human title from the first composer input
 * (spec flows 链1/A4): whitespace-collapsed, hard-truncated to keep sidebar rows sane.
 * Returns null for empty prompts so callers fall back to the provider counter.
 */
export function sessionTitleFromPrompt(prompt: string | undefined | null): string | null {
  const collapsed = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed;
}
