// 通讯录侧 agent 状态视觉映射 —— 从 ContactsPanel 抽出(god freeze 冻结,参考 #2179 抽 groupMemberModels 打法)。
// 文案、颜色与其它每一面同一张表(packages/core/src/shared/agentStatusPresentation.ts,owner 2026-09-25 定):
//   working 运行中 橙 · parked 后台运行中 橙(静止)· needs_user 需要你 黄(Solar 感叹号字形)· error 出错了 红
//   idle 在线 绿 · offline 不在线 灰(owner:待命 → 不在线,「待命会让人以为它还在运行」)· pending 确认中 灰 · removed 已移除
// #6448 之前通讯录把「运行中」也写成「在线」(不强调活动细节),与头像、聊天头给出两个答案 —— 已改成同一句话。
// ❌ 别在此私有飘(#1953 教训):颜色只写 `--agent-tone-*` 这几个 token。
//
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { displayStatusOf, labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { useTranslation } from 'react-i18next'
import { useShownAgentStatus } from './chat/useAgentsOnCloudComputer'

export type AgentContactTone = AgentDisplayStatus

export type AgentContactPresentation = {
  tone: AgentContactTone
  labelKey: `agentStatus.${string}`
  allowsLiveActions: boolean
}

export function agentContactPresentation(status: AgentDisplayStatus): AgentContactPresentation {
  return { tone: status, labelKey: `agentStatus.${labelOfDisplayStatus(status)}`, allowsLiveActions: status !== 'removed' }
}

/**
 * 这一格的那句话。手上有这个 agent 的完整 presentation、且它与这一格画的粗分类是同一个时,用它的文案
 * (等你批准 / 等你回答 …);否则(群成员行按群里的 removed 覆盖过等)用粗分类那一句 —— 字与点永远说同一件事。
 */
export function useAgentContactStatusLabel(status?: AgentDisplayStatus, presentation?: AgentStatusPresentation | null): string {
  const { t } = useTranslation('common')
  if (!status) return ''
  if (presentation && displayStatusOf(presentation.tone) === status) return t(`agentStatus.${presentation.label}`)
  return t(`agentStatus.${labelOfDisplayStatus(status)}`)
}

/**
 * #7199 通讯录这一格画什么(点 / 角标 / 那一句):同 `useShownAgentStatus` —— 宿主闲时收回着的自己的 agent 不画状态
 * (tone = null、没有字),其余照读数。能不能操作(allowsLiveActions)照旧按读数算。
 */
export function useShownAgentContactStatus(agentUserId: string, status: AgentDisplayStatus, presentation?: AgentStatusPresentation | null): { tone: AgentContactTone | null; label: string } {
  const shown = useShownAgentStatus().status(agentUserId, status)
  return { tone: shown ?? null, label: useAgentContactStatusLabel(shown, presentation) }
}

export function agentContactTone(status: AgentDisplayStatus): Pick<AgentContactPresentation, 'tone' | 'labelKey'> {
  const { tone, labelKey } = agentContactPresentation(status)
  return { tone, labelKey }
}

// Tailwind 的 JIT 要在源码里看见完整的类名,所以这张表按 tone 逐条写出,色值只引 `--agent-tone-*`。
export function agentContactRowToneColorClass(tone: AgentContactTone): string {
  if (tone === 'working' || tone === 'parked') return 'bg-[var(--agent-tone-running)]'
  if (tone === 'idle') return 'bg-[var(--agent-tone-online)]'
  if (tone === 'offline' || tone === 'archived' || tone === 'pending' || tone === 'starting') return 'bg-[var(--agent-tone-muted)]'
  if (tone === 'needs_user') return 'bg-[var(--agent-tone-needs-user)]'
  if (tone === 'error') return 'bg-[var(--agent-tone-error)]'
  return 'bg-[var(--agent-tone-removed)]'
}

export function agentContactRowStatusClass(tone: AgentContactTone | null): string {
  const base = 'gg-c-st-dot !mt-0.5 flex items-center gap-1 text-[length:var(--font-body)] text-[var(--muted-fg)]'
  return tone === 'pending' || tone === 'offline' || tone === 'archived' ? `${base} off` : base
}

export function agentContactRowDotClass(tone: AgentContactTone): string {
  // needs_user 是 8px 的 Solar 字形,与 removed 的 5px 色点靠形状 / 字号分,不靠色相分。
  if (tone === 'needs_user') return 'gg-c-st-dot-mark h-[8px] w-[8px] shrink-0'
  return `gg-c-st-dot-mark h-[5px] w-[5px] shrink-0 rounded-[var(--radius-capsule)] ${agentContactRowToneColorClass(tone)}`
}

export function agentContactAvatarBadgeClass(tone: AgentContactTone | null): string {
  if (tone === 'idle') return agentAvatarBadge('after:bg-[var(--agent-tone-online)]')
  if (tone === 'working' || tone === 'parked') return agentAvatarBadge('after:bg-[var(--agent-tone-running)]')
  // needs_user is rendered as a Solar glyph by the row, so do not add the
  // legacy pseudo-element dot on the avatar as a second, ambiguous marker.
  if (tone === 'needs_user') return ''
  if (tone === 'error') return agentAvatarBadge('after:bg-[var(--agent-tone-error)]')
  if (tone === 'removed') return agentAvatarBadge('after:bg-[var(--agent-tone-removed)]')
  return ''
}

/** 头像右下角 after 伪元素小圆点(Tailwind 类串);color 传完整字面类(JIT 需在源码可见)。 */
export const agentAvatarBadge = (color: string) =>
  `relative after:absolute after:right-[-1px] after:bottom-[-1px] after:h-2.5 after:w-2.5 after:rounded-full after:border-2 after:border-transparent after:bg-clip-padding ${color} after:content-[""]`
