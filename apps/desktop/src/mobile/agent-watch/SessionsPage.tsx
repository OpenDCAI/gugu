import { observer } from 'mobx-react-lite'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { Button } from '@/components/ui/Button'
import { ListRowContent } from '@/components/ui/ListRow'
import { IconButton } from '@/components/ui/IconButton'
import { ChevronDown, ChevronUp, MoreHorizontal } from '@/lib/icons'
import { Sheet } from '@/components/ui/Sheet'
import { Menu, MenuItem } from '@/components/ui/Menu'
import { useToast } from '@/components/toastContext'
import { Field } from '@/components/ui/Field'
import { formatRelativeTime } from '@/i18n/format'
import { SessionAvatar } from './StatusGlyph'
import { ScheduleMetaPart } from './schedule-meta'
import { useShownAgentStatus } from '@/components/chat/useAgentsOnCloudComputer'
import { sessionPresentation } from './watch-status'
import { cancelPhoneSessionTurn, updateSession } from './sessionpage-rpc'
import { rowOpens } from '@/session/shared/remote-sessions/session-directory'
import { useLongPress } from '@/hooks/useLongPress'
import './task-flow-catalog'

/*
 * 「项目」页(ProjectsPage)用的会话行与管理动作。这里原来是「一台机器的会话页」:#7199 起手机底栏那一格按项目列、
 * 机器成了属性,那张按机器分的页与它的路由一起删了,行与抽屉留在这儿只有一份。
 */

/**
 * 会话的管理动作(owner 2026-09-15:「会话的删除等管理功能也得加上来」):置顶、改名、归档 —— 桌面侧栏同三条。
 * 收起会话只有归档(#6949,owner 2026-10-06):与桌面、agent 的 `session_archive` 同一个动作,在桌面的会话历史里
 * 恢复得回来,所以 ❌ 再摆删除。贴着点开它的那一下弹出(⋯ 或长按的那一行;owner 10-26 v7.12:❌ 底部抽屉);
 * 改名要打字,换成一张只有输入框的面板。做不成就把机器端的原话摆出来,❌ 悄悄没了。
 */
export function SessionActions({
  anchor,
  session,
  deviceId,
  phoneHost = false,
  onClose,
  onArchived
}: {
  /** 点开菜单的那个元素;null = 菜单收着。 */
  anchor: Element | null
  session: SessionpageSessionSummary | null
  deviceId: string
  phoneHost?: boolean
  onClose: () => void
  onArchived?: () => void
}) {
  const { t } = useTranslation('main')
  const { toast } = useToast()
  const [renaming, setRenaming] = useState<{ deviceId: string; session: SessionpageSessionSummary } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const reason = (err: unknown): string => err instanceof Error ? err.message : String(err)
  const failed = (err: unknown): void => toast(t('agentWatch.sessions.actionFailed'), 'error', reason(err))
  const update = (target: { deviceId: string; session: SessionpageSessionSummary }, patch: { pinned?: boolean; archived?: true }): void => {
    updateSession(target.deviceId, { conversationId: target.session.conversationId, ...patch })
      .then((next) => { if (next.archived) onArchived?.() })
      .catch(failed)
  }
  const rename = (): void => {
    if (!renaming) return
    setBusy(true)
    setError(null)
    updateSession(renaming.deviceId, { conversationId: renaming.session.conversationId, title: draftTitle })
      .then(() => setRenaming(null))
      .catch((err: unknown) => setError(reason(err)))
      .finally(() => setBusy(false))
  }
  const pinned = session?.isPinned === true
  const target = session ? { deviceId, session } : null
  return (
    <>
      {anchor && target ? (
        <Menu anchor={anchor} ariaLabel={target.session.title} onClose={onClose}>
          {phoneHost ? (
            <MenuItem data-testid="agent-watch-session-stop" onClick={() => { void cancelPhoneSessionTurn(target.deviceId, target.session.conversationId).catch(failed) }}>
              {t('agentWatch.sessions.stop')}
            </MenuItem>
          ) : <>
            <MenuItem data-testid="agent-watch-session-pin" onClick={() => update(target, { pinned: !pinned })}>
              {t(pinned ? 'agentWatch.sessions.unpin' : 'agentWatch.sessions.pin')}
            </MenuItem>
            <MenuItem data-testid="agent-watch-session-rename" onClick={() => { setDraftTitle(target.session.title); setError(null); setRenaming(target) }}>
              {t('agentWatch.sessions.rename')}
            </MenuItem>
            <MenuItem data-testid="agent-watch-session-archive" onClick={() => update(target, { archived: true })}>
              {t('agentWatch.sessions.archive')}
            </MenuItem>
          </>}
        </Menu>
      ) : null}
      <Sheet open={renaming !== null} onClose={busy ? () => undefined : () => setRenaming(null)} mobileFitContent testId="agent-watch-session-rename-sheet" ariaLabel={t('agentWatch.sessions.rename')}>
        {renaming ? <div className="gg-aw gg-aw-sheet gg-aw-actions">
          <div className="gg-aw-actions-title">{renaming.session.title}</div>
          {error ? <div className="gg-aw-actions-error" data-testid="agent-watch-session-action-error">{error}</div> : null}
          <Field.Root className="gg-aw-actions-field">
            <Field.Input
              value={draftTitle}
              autoFocus
              maxLength={120}
              data-testid="agent-watch-session-rename-input"
              onChange={(e: { target: { value: string } }) => setDraftTitle(e.target.value)}
              onKeyDown={(e: { key: string }) => { if (e.key === 'Enter' && draftTitle.trim()) rename() }}
            />
          </Field.Root>
          <Button variant="primary" size="lg" className="gg-aw-actions-item" disabled={busy || !draftTitle.trim() || draftTitle.trim() === renaming.session.title} data-testid="agent-watch-session-rename-save" onClick={rename}>
            {t('agentWatch.sessions.renameSave')}
          </Button>
          <Button variant="secondary" size="lg" className="gg-aw-actions-item" disabled={busy} onClick={() => setRenaming(null)}>
            {t('agentWatch.sessions.cancel')}
          </Button>
        </div> : null}
      </Sheet>
    </>
  )
}

/**
 * 一行会话。形制照抄 orca 手机端的 `WorktreeListRow`：
 * 左边一个只表状态的小点，右边两行文字（标题 / 元信息），**没有** chevron，
 * 也没有那个不带任何信息的空气泡图标 —— owner 2026-09-06 圈的就是这两样。
 *
 * 状态词与会话页、聊天同一张表(common:agentStatus.*:运行中 / 后台运行中 / 等你批准… / 出错了 / 做完了 / 空闲);
 * 宿主报上来的是词表里的英文(working / needs_user …),❌ 不许把它原样印到中文界面上。
 */
export const SessionRow = observer(function SessionRow({
  session,
  agentName,
  tags,
  depth,
  childCount,
  childrenOpen,
  onToggleChildren,
  onOpen,
  onMenu,
  statusAvailable,
  phoneHost = false,
}: {
  session: SessionpageSessionSummary
  /** 这条会话背后的 agent 名(`Codex 3`);还没有身份就不给。 */
  agentName?: string | undefined
  /**
   * 行上先于 agent 名的标记(各自一小段):挂在父会话下却在别的机器上时那台机器的名字、同一台别的项目时那个项目的名字;
   * 置顶 / 个人助理那两格里的行没有分区页头可看,标自己的项目与机器;个人助理派的标「由它发起」。
   */
  tags?: readonly string[] | undefined
  /** 在父子树里的深度(子会话缩进);`parentConversationId` 缺席 = 不知道,当根画。 */
  depth: number
  childCount: number
  childrenOpen: boolean
  onToggleChildren: () => void
  onOpen: (session: SessionpageSessionSummary) => void
  /** 管理动作入口(行尾「…」)。机器离线时不给:删除要机器端执行,离线只会等到超时。 */
  /** 管理菜单贴着 anchor 弹出:长按 / 右键是这一行,⋯ 是那颗钮。 */
  onMenu?: ((session: SessionpageSessionSummary, anchor: Element) => void) | undefined
  statusAvailable?: boolean | undefined
  phoneHost?: boolean
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const shownStatus = useShownAgentStatus()
  const presentation = shownStatus.presentation(session.agent?.userId, sessionPresentation(session, statusAvailable ?? session.supported))
  const wrapRef = useRef<HTMLDivElement>(null)
  const longPress = useLongPress(() => { if (wrapRef.current) onMenu?.(session, wrapRef.current) })
  const when = formatRelativeTime(session.lastInteractedAt)
  /*
   * 打不开的行分两种,说的不是同一件事:
   *   · 有 `unsupportedReason` —— 这一行**自己**有问题(harness 不认识之类),就说那句;
   *   · 没有 —— 整台机器离线,页顶横幅已经说过一次,行只说它自己的(agent / 时间)。点不动由灰掉的样式表达,
   *     ❌ 不必 11 行重复同一句话。机器离线时状态由图标说(presentation 为 null ⇒ 灰点,❌ 替连不上的机器说「在跑」)。
   */
  /*
   * owner 10-09:一行里塞「agent 名 · 状态 · harness · 时间」四样,手机宽度放不下,处处省略号。
   *   · 状态不写成字:左边的图标已经是它(StatusGlyph,同一份 presentation);
   *   · 有 agent 名就不写 harness:名字(Claude 1 / Codex 3)本来就说了是哪家;
   *   · agent 名与标题说的是一件事(带标题起的 agent 名字就是标题,或标题的开头)不再说一遍。
   * 打不开 / 没起来的行照旧写它自己的那句话(下面 rowMeta)。
   */
  const named = agentName && !session.title.startsWith(agentName) && !agentName.startsWith(session.title) ? agentName : undefined
  const agentKind = phoneHost ? tFlow('phoneAgent') : session.harness
  const ownMeta = [named ? null : agentKind, when].filter((x): x is string => !!x)
  /*
   * 没有记录可读的会话,新宿主照样打得开(spec session-always-openable,#6264):转录里是第一句话,
   * 为什么没起来说在那台机器那边。老宿主(不带 recordState)打不开,说一句「这里打不开」——
   * ❌ 把 `unsupportedReason` 那句开发者原文摊在行上。
   */
  const openable = rowOpens(session)
  const rowMeta: string[] = session.supported
    ? ownMeta
    : session.recordState === 'not-started'
      ? [t('agentWatch.sessions.notStarted'), agentKind, when].filter((x): x is string => !!x)
      : session.recordState === 'harness-unsupported'
        ? [t('agentWatch.sessions.harnessUnsupported'), agentKind].filter((x): x is string => !!x)
        : session.unsupportedReason
          ? [t('agentWatch.sessions.cannotOpen')]
          : ownMeta
  const meta = [...(tags ?? []), named, ...rowMeta].filter((x): x is string => !!x)

  return (
    <div
      ref={wrapRef}
      className="gg-aw-item-wrap"
      data-depth={depth}
      style={depth > 0 ? { paddingInlineStart: `calc(${depth} * var(--spacing-lg))` } : undefined}
    >
    <Button
      variant="ghost"
      size="option"
      className="gg-list-row gg-row gg-aw-item"
      data-mobile=""
      data-emphasis={presentation?.emphasis || undefined}
      aria-disabled={openable ? undefined : true}
      disabled={!openable}
      data-session-id={session.conversationId}
      data-supported={session.supported ? 'true' : 'false'}
      {...(onMenu ? longPress : {})}
      onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(session, event.currentTarget) } : undefined}
      onClick={openable ? () => onOpen(session) : undefined}
    >
      <ListRowContent title={session.title} leading={
        <SessionAvatar
          agentId={session.agent?.userId}
          sessionId={session.conversationId}
          presentation={presentation}
          size={depth > 0 ? 28 : 40}
        />
      } subtitle={
        <span className="gg-aw-item-meta">
          {session.schedule ? <ScheduleMetaPart schedule={session.schedule} /> : null}
          {meta.map((part, i) => (
            <span key={part + String(i)} className="gg-aw-item-part">{part}</span>
          ))}
        </span>
      } />
    </Button>
    {childCount > 0 ? (
      <IconButton
        size="lg"
        className="gg-aw-item-menu"
        aria-expanded={childrenOpen}
        aria-label={t(childrenOpen ? 'agentWatch.sessions.collapseChildren' : 'agentWatch.sessions.expandChildren', { count: childCount })}
        data-testid="agent-watch-session-children-toggle"
        onClick={onToggleChildren}
      >
        {childrenOpen ? <ChevronUp /> : <ChevronDown />}
      </IconButton>
    ) : null}
    {onMenu ? (
      <IconButton
        size="lg"
        className="gg-aw-item-menu"
        aria-label={t('agentWatch.sessions.menu')}
        data-testid="agent-watch-session-menu"
        onClick={(event) => onMenu(session, event.currentTarget)}
      >
        <MoreHorizontal />
      </IconButton>
    ) : null}
    </div>
  )
})
