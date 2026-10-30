import { agentLocationText } from '../../lib/agentRunningStatusModels'
import type { CSSProperties } from 'react'
import type { TFunction } from 'i18next'
import type { GroupJoinMode } from '@gugu/core/shared/types/chat'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { agentStatusText } from '@/lib/agentStatusText'
import {
  agentEngineDisplayName,
  type AgentLocation,
} from '@gugu/core/shared/ui/agentHeaderStatusModels'

export const COLOR_ACCENT = 'var(--accent)'
export const COLOR_ON_ACCENT = 'var(--text-on-accent)'
export const COLOR_MUTED = 'var(--text-secondary)'
export const COLOR_PLACEHOLDER = 'var(--text-tertiary)'

/**
 * @deprecated 用 `ui/IconButton` —— 图标钮的唯一实现(尺寸取 --control-h-*、图标取 --icon-*、三态来自 .gg-ghost)。
 * 这份 28×28 / 4px 圆角的内联副本只剩 WidgetCard 一个消费点(不在本轮迁移范围)；它迁完这个常量随即删除。
 * ❌ 新代码别再引用。同族的 `GHOST_BTN`(30×30 药丸)消费点已清空、常量已删。
 */
export const ICON_BTN: CSSProperties = {
  width: '28px',
  height: '28px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 'var(--radius-document)',
}

/**
 * 单聊头「{状态} · {位置} · {引擎}」。状态是这个 agent 的完整 presentation 那一句(等你批准 / 后台运行中 …);
 * 不画状态(null,#7199 宿主闲时收回着)= 只说位置与引擎。
 */
export function localizedAgentHeaderStatus(
  label: AgentStatusLabel | null,
  location: AgentLocation | null | undefined,
  engine: Parameters<typeof agentEngineDisplayName>[0],
  t: TFunction<'messaging'>,
): string {
  const locationLabel = agentLocationText(location ?? null, t)
  return [label ? agentStatusText(label) : null, locationLabel, agentEngineDisplayName(engine)]
    .filter((segment): segment is string => Boolean(segment))
    .join(' · ')
}

export function joinModeDescription(mode: GroupJoinMode, t: TFunction<'messaging'>): string {
  if (mode === 'open') return t('group.settings.joinModeDescriptions.open')
  if (mode === 'approval') return t('group.settings.joinModeDescriptions.approval')
  return t('group.settings.joinModeDescriptions.inviteOnly')
}

export function readReceiptLabel(
  read: number,
  total: number,
  t: TFunction<'messaging'>,
): string {
  if (total <= 1) return read > 0 ? t('message.read') : t('message.unread')
  return read < total
    ? t('message.readUnreadCount', { read, unread: total - read })
    : t('message.readCount', { read })
}
