import { scheduleComposerFocus } from '@/lib/focusComposer'
import { agentLocationText } from '../../lib/agentRunningStatusModels'
import type { CSSProperties } from 'react'
import type { TFunction } from 'i18next'
import type { GroupJoinMode } from '@gugu/core/shared/types/chat'
import type { AgentStatusLabel, AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { agentStatusText } from '@/lib/agentStatusText'
import { isLookAvatar } from '../agentAvatar/look'
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

export function insertTextAtRange(value: string, insert: string, start: number, end: number): string {
  return value.slice(0, start) + insert + value.slice(end)
}

/**
 * 插入表情/提及后回到插入点。聚焦本身走 [[composer]] 的唯一契约（含它的门控与跨渲染边界重试），
 * 这里只负责「落在哪个框、光标放哪」——❌ 不再自带一份 `setTimeout` + `.focus()`（#4315）。
 */
export function focusTextareaAt(textarea: HTMLTextAreaElement | null, cursor: number): void {
  if (!textarea) return
  scheduleComposerFocus('caret-move', { caret: cursor, target: () => textarea })
}

/**
 * agent 单聊桌面头栏上的悬浮小鸟(AgentChatHero,画布 80、上沿贴窗格顶边)探出头栏的高度:身体底边在画布 95% 处
 * ≈ 76px,头栏 52px,再留一点落地的压扁 ⇒ 24。消息列表顶部据此让位,滚到最上面时第一条 / 日期分隔不被它的脚盖住。
 * 改小鸟尺寸或位置时一起改(见 tokens.css .gg-agent-header)。只对小鸟生效 —— 照片 agent 用 `isAgentHeroBird` 判。
 */
export const AGENT_HERO_OVERHANG_PX = 24

/**
 * 单聊头栏里这个 agent 画的是不是会动的小鸟(没传照片,或头像地址是「形象」);传了照片的 agent 是一张圆图,
 * 没有小鸟头顶那圈留白 —— 放大、上移、探出都会把脸顶出窗格被裁,所以它保持原来的尺寸、居中。
 * 与 Avatar 的判法一致:显式给了一个不是形象的地址(哪怕是坏的)就不是小鸟。
 */
export function isAgentHeroBird(avatarUrl: string | null | undefined): boolean {
  return avatarUrl == null || isLookAvatar(avatarUrl)
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

/**
 * 单聊头栏那一句的全部输入:状态的完整 presentation、在哪台机器、哪个引擎(引擎取不到 = engineMissing)。
 * presentation = null:不画状态(#7199 宿主闲时收回着),位置与引擎照写。
 */
export interface AgentHeaderStatus {
  peerId: string
  presentation: AgentStatusPresentation | null
  location: AgentLocation | null
  engine: Parameters<typeof agentEngineDisplayName>[0]
  engineMissing: boolean
}

/** 同一句话的纯文本(名字的悬停提示用;引擎取不到时这一段不写)。 */
export function agentHeaderStatusText(status: AgentHeaderStatus, t: TFunction<'messaging'>): string {
  return localizedAgentHeaderStatus(status.presentation?.label ?? null, status.location, status.engineMissing ? null : status.engine, t)
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
