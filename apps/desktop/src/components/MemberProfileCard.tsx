import { useEffect, useState, type ReactNode } from 'react'
import type { AgentDisplayStatus, GroupMemberRole, GroupMemberType, ListenMode } from '@gugu/core/shared/types/chat'
import { LISTEN_MODES } from '@gugu/core/shared/types/chat'
import { createContactQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { Avatar } from './Avatar'
import { AgentOwnerLabel } from './AgentOwnerLabel'
import { useAuth } from '../store/auth'
import { OwnedAgentNameEditor } from './contacts/OwnedAgentNameEditor'
import { SharePosterDialog } from './SharePosterDialog'
import { GUGU_ANDROID_DOWNLOAD_URL } from '../lib/appLinks'
import { useTranslation } from 'react-i18next'
import { resolveMessagingValue } from '@/lib/localizedStoredValue'
import { useAgentContactStatusLabel } from './contactAgentTone'
import { useAgentDisplayStatus } from '../hooks/useAgentDisplayStatus'
import { Button } from './ui/Button'
import { cn } from '@/lib/cn'
import { CommunityPointsTag } from './forum/CommunityPointsTag'
import { useAgentSession } from '@/lib/projectGroupChatsBridge'
import type { AgentSession } from '@/session/renderer/features/projects/stores/project-group-chats-bridge'

// @@@float-one-edge (Refs #6104) — 名片是浮层:圆角 xl(12) + 一层 lift,❌ 不再叠描边。
const profileCardClass = 'gg-pop w-[284px] overflow-hidden rounded-xl bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-lift)]'
// 放进底部面板(手机,#6836)时铺满宽度,圆角、底色归面板,卡片不再叠第二层外框。
const profileFillClass = 'gg-pop w-full text-[var(--text-primary)]'
const profileSingleClass = 'gg-pop--single'
const profileHeaderClass = 'gg-pop-ph flex items-center gap-3.5 border-b border-[var(--border-color)] px-[22px] pb-4 pt-[22px]'
const profileHeaderTextClass = 'gg-pop-ph-text flex min-w-0 flex-col'
const profileNameClass = 'gg-pop-pn min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold text-[var(--text-primary)]'
const profileTagClass = 'gg-pop-pt mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--font-body)] text-[var(--text-tertiary)]'
const profileActionsClass = 'gg-pop-pacts flex flex-wrap gap-2 px-[18px] pb-3 pt-3.5'
const profileButtonClass = 'gg-pop-pbtn flex-[1_1_auto] text-[length:var(--font-body)] [&_svg]:shrink-0'
const profileFieldsClass = 'gg-pop-fields flex flex-col gap-1.5 px-[18px] pb-3.5'
const profileFieldRowClass = 'gg-pop-field-row grid grid-cols-[56px_minmax(0,1fr)] items-start gap-2 text-[length:var(--font-caption)] leading-4'
const profileFieldLabelClass = 'gg-pop-field-label text-[var(--text-tertiary)]'
const profileFieldValueClass = 'gg-pop-field-value [overflow-wrap:anywhere] text-[var(--text-secondary)]'
const profileAgentMetaClass = 'mt-[3px] flex flex-wrap gap-x-2.5 gap-y-0.5 text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--text-tertiary)] [&>*]:max-w-full [&>*]:truncate'
const profileListenClass = 'gg-pop-lm px-[18px] pb-[18px] pt-1'
const profileListenLabelClass = 'gg-pop-lml mb-[7px] text-[length:var(--font-body)] text-[var(--text-secondary)]'
// @@@1344(b) — 倾听模式分段壳:椭圆/胶囊(rounded-full)→圆角矩形(rounded-lg=8px,对齐 SSOT 基础圆角 `--r`)。
const profileListenSegmentClass = 'gg-pop-lmseg flex gap-1.5 rounded-lg bg-[var(--listen-mode-bg)] p-[3px]'
const profileListenButtonBaseClass = 'gg-pop-lmseg-btn flex-1 rounded-md border-none px-0 py-1.5 font-[inherit] text-xs font-medium !transition-[background,color] !duration-[var(--dur-fast)] !ease-[var(--ease)]'
const profileListenButtonActiveClass = 'gg-pop-lmseg-btn--on bg-[var(--listen-mode-active-bg)] text-[var(--listen-mode-active-fg)] shadow-[var(--listen-mode-active-shadow)]'
const profileListenButtonInactiveClass = 'bg-transparent text-[var(--listen-mode-fg)]'

// @@@1255 — 管理区表单（群角色 / 移出群聊）。
// 设计稿的 .pop 资料卡本身没有管理表单（管理控件在群设置抽屉里），故这里借用设置抽屉的
// aset-row / aset-sel / .tgl / aset-danger 习语，但按资料卡 popover 的紧凑尺度落地（标签/选择走
// --font-body，而非照抄抽屉的 13px）。色值复用代码库既有组件（asClass.profileDanger）。
const profileManageClass = 'gg-pop-manage flex flex-col gap-2.5 border-t border-[var(--border-subtle)] px-[18px] pb-[18px] pt-3'
const profileManageRowClass = 'gg-pop-manage-row flex items-center justify-between gap-3'
// 双行（标签+描述）行用 flex-start 顶对齐开关，对齐 .aset-row 与群设置抽屉 通知/邀请链接 行的既有写法。
const profileManageLabelClass = 'gg-pop-manage-label text-[length:var(--font-body)] font-medium text-[var(--text-primary)]'
const profileManageSelectClass = 'gg-pop-manage-sel max-w-[52%] shrink-0 cursor-pointer rounded-lg border border-[var(--border-strong)] bg-[var(--bg-primary)] px-2 py-1.5 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none [font-family:inherit] focus:border-[var(--accent)] disabled:cursor-default disabled:opacity-60'
// @@@2322 危险项 hover 归 --danger-tint(spec:状态反馈唯一允许的色相);rest 底 #ef44440d 是静止装饰 tint,
// 无对应 token(--danger-tint 是 hover 档)、观感逐值保持 → 保留字面值。
const profileManageDangerClass = 'gg-pop-manage-danger !mt-0.5 w-full cursor-pointer rounded-lg border-0 bg-[var(--danger-tint)] !py-2.5 text-[length:var(--font-body)] font-medium text-[var(--danger)] [font-family:inherit] transition-[background] duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-[var(--danger-tint)] disabled:cursor-default disabled:opacity-50'
// @@@2247 - inline error line for a failed manage mutation, rendered inside the card portal (danger tint).
const profileManageErrorClass = 'gg-pop-manage-error mt-0.5 text-[length:var(--font-caption)] leading-[1.4] text-[var(--danger)]'

function listenModeButtonClass(active: boolean): string {
  return cn(profileListenButtonBaseClass, active ? profileListenButtonActiveClass : profileListenButtonInactiveClass)
}

// ── SVG icons (design #pop) ───────────────────────────────────────────────
// 发消息 — chat bubble
const IconMsg = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
    <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z"/>
  </svg>
)

// 悄悄话 — whisper / two-person figure
const IconWhisper = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
    <g fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" d="M16.5 20.5L17 15l-3.143-1.258a5 5 0 0 0-3.714 0L7 15l.5 5.5M7 15l-4.5-2M17 15l4.5-2"/>
      <ellipse cx="15" cy="10.5" fill="currentColor" rx="1" ry="1.5"/>
      <ellipse cx="9" cy="10.5" fill="currentColor" rx="1" ry="1.5"/>
    </g>
  </svg>
)

// 分享 — share / upload arrow
const IconShare = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
      <path d="M4 12a8 8 0 1 0 16 0"/>
      <path strokeLinejoin="round" d="M12 14V4m0 0l3 3m-3-3L9 7"/>
    </g>
  </svg>
)

// ── Public types ──────────────────────────────────────────────────────────────

export interface MemberProfileCardModel {
  id: string
  guguNumber?: number | null
  displayName: string
  avatar: string | null
  email: string | null
  /** Bio text from ContactUser.bio or agent profile. Null = no bio set. */
  bio?: string | null
  type: GroupMemberType
  ownerUserId?: string | null
  ownerDisplayName?: string | null
  role: GroupMemberRole
  profileScope?: 'group' | 'direct'
  /** 'former' = 不在当前名册、只因发过消息而有资料(退群 / 被移出);成员列表不列他,消息气泡与资料卡照常。 */
  membership?: 'current' | 'former'
  agentStatus?: AgentDisplayStatus
  /** listen_mode from GroupAgentItem (agent-only, group scope). */
  listenMode?: ListenMode
  agentMeta?: {
    currentTaskTitle?: string | null
    lastAction?: string | null
  }
}

export type MemberProfileChatTarget = {
  id: string
  displayName: string
  avatar: string | null
  email: string | null
  bio: string | null
  type: GroupMemberType
  /** 这个 agent 是某台机器上的一条会话:「发消息」打开的是它的会话页,❌ 另开一个空私聊。 */
  session?: AgentSession
}

// @@@profile-edit-controls - Rendered for a group owner/admin (role, remove) and for an agent's owner
// (listen mode, take it out of the group). Each handler is optional; the card renders only what is wired.
export interface MemberProfileEditControls {
  canChangeRole?: boolean
  onChangeRole?: (role: GroupMemberRole) => Promise<void> | void
  // @@@1208 (#857 收尾) listen-mode 变更:agent 的主人看它时父级才给这个回调,分段控件变可交互(否则只读镜像)。
  onChangeListenMode?: (mode: ListenMode) => Promise<void> | void
  canRemove?: boolean
  onRemove?: () => Promise<void> | void
  busy?: boolean
  // @@@2247 - error text for the last manage-control mutation (remove / role / listen). The
  // card is a portal overlay, so the drawer-body error line renders BEHIND it and the owner sees nothing
  // (e.g. "移出群聊" on a ghost member fails fail-loud but silently). Surface it INSIDE the card instead.
  editError?: string | null
}

// @@@profile-alias - Provided only when the member is one of the viewer's contacts
// (self and non-contacts are absent from the contacts list, so they get no editor).
export interface MemberProfileAliasControls {
  alias: string | null
  onSave: (alias: string) => Promise<void> | void
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function AliasField({ controls }: { controls: MemberProfileAliasControls }) {
  const { t } = useTranslation('contacts')
  const saved = controls.alias ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(controls.alias ?? '') }, [controls.alias])

  const save = async () => {
    const next = draft.trim()
    if (next === saved || saving) return
    setSaving(true)
    try { await controls.onSave(next) } finally { setSaving(false) }
  }

  return (
    <div className={profileFieldRowClass}>
      <span className={profileFieldLabelClass}>{t('profile.alias')}</span>
      <input
        data-profile-alias-input
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(saved)
        }}
        placeholder={t('profile.notSet')}
        maxLength={80}
        style={{ minWidth: 0, height: 24, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-document)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--font-caption)', padding: '0 6px', outline: 'none', fontFamily: 'inherit' }}
      />
    </div>
  )
}

function DataRow({ field, label, value }: { field: string; label: string; value: ReactNode }) {
  return (
    <div className={profileFieldRowClass}>
      <span className={profileFieldLabelClass}>{label}</span>
      <span data-profile-field={field} className={profileFieldValueClass}>{value}</span>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function MemberProfileCard({
  member,
  onOpenChat,
  onWhisper,
  editControls,
  aliasControls,
  fill = false,
}: {
  member: MemberProfileCardModel
  onOpenChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 群聊模式下悄悄话入口；仅 isGroupProfile && onWhisper 时渲染。
  onWhisper?: (target: MemberProfileChatTarget) => void
  editControls?: MemberProfileEditControls
  aliasControls?: MemberProfileAliasControls
  fill?: boolean
}) {
  const { t } = useTranslation('contacts')
  const isAgent = member.type === 'agent'
  // single = direct scope (not in a group) → matches prototype .pop.single
  const isSingle = member.profileScope !== 'group'
  const isGroupProfile = !isSingle
  const status = member.agentStatus
  const { presence } = useAgentDisplayStatus(isAgent ? member.id : null)
  const statusLabel = useAgentContactStatusLabel(status, presence.presentation)
  const { user } = useAuth()
  // 别人的 agent 不能私聊(#509):不画能点的「发消息」(#6832)。通讯录那边同一条规则见 ContactsPanel 的 isOwnedAgent。
  const canOpenChat = !!onOpenChat && (!isAgent || member.ownerUserId === user?.id)
  const session = useAgentSession(isAgent ? member.id : null)
  const editBusy = !!editControls?.busy
  const showEdits = isGroupProfile && (editControls?.canChangeRole || editControls?.canRemove)
  const roleLabel = member.role === 'owner' ? t('profile.roles.owner') : member.role === 'admin' ? t('profile.roles.admin') : t('profile.roles.member')

  // Listen-mode (倾听模式): agent-only, group scope.
  // member.listenMode comes from GroupAgentItem.listen_mode via toAgentProfile.
  // Defaults to 'active' when absent (matches DB default). The card mirrors
  // the real state read-only; mutation lives in GroupCollabPanel's own control.
  const showListenMode = isAgent && isGroupProfile
  const listenMode: ListenMode = member.listenMode ?? 'active'
  // @@@1208 (#857 收尾) 仅当父级(agent 的主人)接了 onChangeListenMode 才让分段控件可交互;否则只读镜像。
  const canEditListenMode = showListenMode && !!editControls?.onChangeListenMode

  // @@@share (#1111) — 分享按钮复用既有 contact QR 分享卡（SharePosterDialog）。
  // 由成员的咕咕号生成同款 add-me QR；无咕咕号则无法生成 → 按钮禁用 fail-loud，不出死按钮/假占位。
  const [showShare, setShowShare] = useState(false)
  const shareQrValue =
    typeof member.guguNumber === 'number' && Number.isInteger(member.guguNumber) && member.guguNumber > 0
      ? createGuguQrScanUrl(createContactQrPayload(member.guguNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })
      : null
  const canShare = shareQrValue !== null

  const handleOpenChat = () => {
    if (!onOpenChat) return
    onOpenChat({
      id: member.id,
      displayName: member.displayName,
      avatar: member.avatar,
      email: member.email,
      bio: member.bio ?? null,
      type: member.type,
      session,
    })
  }

  // Keep the actual avatar at the card's size; badges must remain outside its bounds.
  const avatarSize = 52

  return (
    <>
    <div className={cn(fill ? profileFillClass : profileCardClass, isSingle && profileSingleClass)}>
      {/* ── Header: avatar + name + tag (prototype .ph, line 445-446) ── */}
      <div className={profileHeaderClass}>
        <div style={{ width: avatarSize, height: avatarSize, flexShrink: 0, position: 'relative' }}>
          <Avatar
            name={member.displayName}
            avatarUrl={member.avatar}
            seed={member.id}
            size={avatarSize}
            isAgent={isAgent}
            agentStatus={status}
          />
        </div>
        <div className={profileHeaderTextClass} style={{ flex: 1, minWidth: 0 }}>
          {isAgent ? <OwnedAgentNameEditor key={member.id} agentId={member.id} name={member.displayName} ownerUserId={member.ownerUserId} status={status} membership={member.membership} className="text-base font-semibold"><span className={profileNameClass}>{member.displayName}</span></OwnedAgentNameEditor> : <div className={profileNameClass}>{member.displayName}</div>}
          {/* One metadata line, the same cells-with-gap idiom as the agent's row in the member list. */}
          {isAgent ? (
            <div data-profile-agent-meta className={profileAgentMetaClass}>
              {statusLabel ? <span>{statusLabel}</span> : null}
              <span data-profile-agent-owner><AgentOwnerLabel ownerUserId={member.ownerUserId} ownerDisplayName={member.ownerDisplayName} /></span>
            </div>
          ) : <CommunityPointsTag userId={member.id} className={profileTagClass} />}
        </div>
      </div>

      {/* ── Action buttons (prototype .pacts, lines 450-452) ─────────── */}
      <div className={profileActionsClass}>
        {/* 发消息 — wired to existing onOpenChat handler */}
        {canOpenChat ? (
          <Button
            size="sm"
            data-testid="member-profile-send-message-button"
            className={profileButtonClass}
            onClick={handleOpenChat}
          >
            <IconMsg />
            {t('common.sendMessage')}
          </Button>
        ) : null}

        {/* 悄悄话 — 群聊模式且父组件提供 onWhisper 时显示（对标设计稿 .pbtn.hide-single）。 */}
        {isGroupProfile && onWhisper ? (
          <Button
            size="sm"
            className={profileButtonClass}
            onClick={() => {
              onWhisper({
                id: member.id,
                displayName: member.displayName,
                avatar: member.avatar,
                email: member.email,
                bio: member.bio ?? null,
                type: member.type,
              })
            }}
          >
            <IconWhisper />
            {t('profile.whisper')}
          </Button>
        ) : null}

        {/* 分享 — prototype line 822. #1111: 接既有 contact QR 分享卡（SharePosterDialog）。 */}
        <Button
          size="sm"
          className={profileButtonClass}
          disabled={!canShare}
          title={canShare ? undefined : t('profile.shareUnavailable')}
          onClick={() => { if (canShare) setShowShare(true) }}
        >
          <IconShare />
          {t('common.share')}
        </Button>
      </div>

      {/* ── Data fields (咕咕号 / 群角色 / etc) ─────
          Not in prototype visual but preserved for existing tests and data display.
          咕咕号 always rendered — direct profiles need it too (test invariant).
          @@@1344(a) — group-agent 卡隐藏群语境字段(备注/群角色/咕咕号/任务/动作)，保留身份字段
          (简介/邮箱)、倾听模式与管理区。直接资料卡与群里的人类成员卡保留完整字段。 ─── */}
      {member.bio || member.email || !(isAgent && isGroupProfile) ? (
        <div className={profileFieldsClass}>
          {member.bio ? <DataRow field="bio" label={t('profile.bio')} value={member.bio} /> : null}
          {member.email ? <DataRow field="email" label={t('profile.email')} value={member.email} /> : null}
          {!(isAgent && isGroupProfile) ? (
            <>
              {aliasControls ? <AliasField controls={aliasControls} /> : null}
              {isGroupProfile ? (
                <DataRow field="role" label={t('profile.groupRole')} value={roleLabel} />
              ) : null}
              <DataRow field="id" label={t('common.guguNumber')} value={member.guguNumber == null ? t('common.unassigned') : member.guguNumber} />
              {isAgent ? (
                <>
                  {member.agentMeta?.currentTaskTitle ? (
                    <DataRow field="current-task" label={t('profile.currentTask')} value={member.agentMeta.currentTaskTitle} />
                  ) : null}
                  {member.agentMeta?.lastAction ? (
                    <DataRow field="last-action" label={t('profile.lastAction')} value={resolveMessagingValue(member.agentMeta.lastAction)} />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── 倾听模式 segmented control (prototype .lm/.lmseg, lines 453-457)
          Agent-only, group scope. @@@1208 (#857 收尾): agent 的主人看它时父级经 editControls.onChangeListenMode
          提供回调,控件可交互(点击改档→真 mutation chat_members.listen_mode);其余人(含群主 / 管理员)
          是只读镜像(cursor default)。 ── */}
      {showListenMode ? (
        <div className={profileListenClass}>
          <div className={profileListenLabelClass}>{t('profile.listenModeDescription')}</div>
          <div className={profileListenSegmentClass}>
            {LISTEN_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={listenModeButtonClass(listenMode === mode)}
                disabled={canEditListenMode ? editBusy : undefined}
                style={{ cursor: canEditListenMode ? 'pointer' : 'default' }}
                onClick={canEditListenMode ? () => { void editControls?.onChangeListenMode?.(mode) } : undefined}
              >
                {mode === 'passive' ? t('profile.listenModes.passive') : t('profile.listenModes.proactive')}
              </button>
            ))}
          </div>
          {/* 只接了档位的卡(消息头像 / 话题)没有下面那块管理区,没改成的原因就写在分段下面。 */}
          {!showEdits && editControls?.editError ? (
            <div className={profileManageErrorClass} role="alert" data-profile-edit-error={member.id}>
              {editControls.editError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Edit controls (group owner/admin: role, remove; agent owner: take it out of the group) ── */}
      {showEdits ? (
        <div className={profileManageClass}>
          {editControls?.canChangeRole ? (
            <div className={profileManageRowClass}>
              <span className={profileManageLabelClass}>{t('profile.groupRole')}</span>
              <select
                data-profile-role-select={member.id}
                className={profileManageSelectClass}
                value={member.role}
                disabled={editBusy}
                onChange={(event) => editControls.onChangeRole?.(event.target.value as GroupMemberRole)}
              >
                {(['owner', 'admin', 'member'] as const).map((role) => <option key={role} value={role}>{role === 'owner' ? t('profile.roles.owner') : role === 'admin' ? t('profile.roles.admin') : t('profile.roles.member')}</option>)}
              </select>
            </div>
          ) : null}
          {editControls?.canRemove ? (
            <button
              type="button"
              data-profile-remove-button={member.id}
              className={profileManageDangerClass}
              onClick={() => editControls.onRemove?.()}
              disabled={editBusy}
            >
              {isAgent && member.ownerUserId === user?.id ? t('profile.agentLeaveGroup') : t('profile.removeFromGroup')}
            </button>
          ) : null}
          {editControls?.editError ? (
            <div className={profileManageErrorClass} role="alert" data-profile-edit-error={member.id}>
              {editControls.editError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
    {showShare && shareQrValue ? (
      <SharePosterDialog
        title={member.displayName}
        subtitle={isAgent ? 'Agent · 咕咕' : '咕咕'}
        qrValue={shareQrValue}
        onClose={() => { setShowShare(false) }}
      />
    ) : null}
    </>
  )
}
