import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CSSProperties, ReactNode } from 'react'
import { buildGroupInviteShareUrl } from '../../lib/groupInviteShareUrl'
import { useMobileShell } from '../../hooks/useMobileShell'
import type { ChatItem, GroupCollabSnapshot, NotificationLevel } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { GroupNameRow } from './GroupNameRow'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { displayAvatarUrl } from '../../lib/dicebearAvatar'
import { useAgentLookPostersVersion } from '../agentAvatar/posters'
import { SharePosterDialog } from '../SharePosterDialog'
import { buildUnifiedMembers } from './groupMemberModels'
import { chatService } from '../../lib/chat'
import { useToast } from '../toastContext'
import { useChatStore } from '../../store/chatContext'
import { ChatManagementActions } from './ChatManagementActions'
import { GroupSettingsManagePage } from './GroupSettingsManagePage'
import { MemberListPanel, type MemberListPanelProps } from './MemberListPanel'
import { AnnouncementDrawer } from './AnnouncementDrawer'
import { groupRoleRevision, useGroupChatSettings } from './useGroupChatSettings'
import { useSettingsPages } from './useSettingsPages'
import { MemberInviteLink, SettingsNavRow, SettingsPageFrame, SettingsPageHead } from './groupSettingsUi'
import {
  settingsBodyStyle,
  settingsErrorStyle,
  settingsMobileBodyStyle,
  settingsReadOnlyBoxStyle,
  settingsSectionLabelStyle,
  settingsTextareaStyle,
} from './groupSettingsStyles'

// @@@6418 群聊设置 = 一个页面栈(useSettingsPages):成员、公告、群管理、规则、描述各是一页。

const profileRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }
const avatarFrameStyle: CSSProperties = {
  position: 'relative', width: 52, height: 52, borderRadius: 'var(--radius-2xl)', overflow: 'hidden', flexShrink: 0,
  background: 'transparent', display: 'grid', placeItems: 'center', cursor: 'default',
}
const avatarFrameEditableStyle: CSSProperties = { ...avatarFrameStyle, cursor: 'pointer' }
const avatarFrameDragStyle: CSSProperties = { ...avatarFrameEditableStyle, border: '1px dashed var(--primary)' }
const avatarUploadingStyle: CSSProperties = {
  position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--bg-overlay-modal)',
  color: 'var(--color-white)', fontSize: 'var(--font-caption)',
}
const hiddenStyle: CSSProperties = { display: 'none' }
const profileTextStyle: CSSProperties = { flex: 1, minWidth: 0 }
const memberCountStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--muted-fg)', marginTop: 3 }
const memberStackStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', marginRight: 8 }
const memberStackItemStyle: CSSProperties = { display: 'inline-flex', marginLeft: -6, borderRadius: 'var(--radius-circle)' }
const leaveStyle: CSSProperties = {
  marginTop: 20, textAlign: 'center', color: 'var(--danger-fg)', fontSize: 'var(--font-body)', fontWeight: 500,
  cursor: 'pointer', padding: 11, borderRadius: 'var(--radius-xl)', background: 'var(--danger-tint)',
}
const confirmStyle: CSSProperties = { marginTop: 20 }
const confirmTextStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-secondary)', margin: '0 0 8px' }
const confirmActionsStyle: CSSProperties = { display: 'flex', gap: 8 }
const confirmButtonStyle: CSSProperties = { flex: 1 }
const MEMBER_PREVIEW_COUNT = 5

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split('\n').find((part) => part.trim())
  return line?.trim() || null
}

export function GroupMembersSection({
  chat,
  initialPage,
  snapshot,
  snapshotError,
  currentUserId,
  onReload,
  onClose,
  onLeaveGroup,
  onDissolveGroup,
  onOpenUserChat,
  onWhisper,
  onOpenSearch,
  onSetNotificationLevel,
  onTogglePinned,
  onClearMessages,
}: {
  chat: ChatItem
  /** Opened at the members' list or the announcement (the info tab's members button); back: the first page. */
  initialPage?: 'main' | 'members' | 'announcement'
  snapshot: GroupCollabSnapshot
  snapshotError?: MemberListPanelProps['error']
  currentUserId: string | null
  onReload: () => Promise<void>
  onClose: () => void
  /** 可能是 async —— await 它,失败才进得了错误行(#1730)。缺省走 chatService.removeGroupMember。 */
  onLeaveGroup?: () => void | Promise<void>
  /** 群主解散;同样 await(#1731)。 */
  onDissolveGroup?: () => void | Promise<void>
  onOpenUserChat?: MemberListPanelProps['onOpenUserChat']
  onWhisper?: MemberListPanelProps['onWhisper']
  onOpenSearch: () => void
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  onClearMessages: () => Promise<void>
}) {
  const chatId = chat.id
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const { toast } = useToast()
  const mobileShell = useMobileShell()
  const { page, push, pop } = useSettingsPages(chatId, initialPage)

  const { settings, error: settingsError, setError: setSettingsError, update, setAvatarUrl } = useGroupChatSettings(chatId, groupRoleRevision(snapshot))
  const viewerRole = settings?.my_role ?? null
  const viewerIsManager = settings?.can_manage === true

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmExit, setConfirmExit] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarDragOver, setAvatarDragOver] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [showSharePoster, setShowSharePoster] = useState(false)
  const [draft, setDraft] = useState('')

  const unifiedMembers = useMemo(() => buildUnifiedMembers(snapshot), [snapshot])
  const totalMembers = snapshot.humans.length + snapshot.agents.length
  const inviteLink = useMemo(
    () => buildGroupInviteShareUrl(settings?.public_id ?? null, settings?.join_token ?? null),
    [settings?.public_id, settings?.join_token],
  )
  // @@@1461-gap3 群头像组合只用成员已有的 canonical URL,与聊天列表群项同口径。
  const groupAvatarMembers = useMemo(
    () => unifiedMembers.slice(0, 9).map((m) => ({ id: m.id, name: identitiesById[m.id]?.display_name ?? '', avatar: identitiesById[m.id]?.avatar ?? null })),
    [identitiesById, unifiedMembers],
  )
  // @@@445/#2470 海报 canvas 不走 React Avatar → 按同一口径预解析成员头像;小鸟的定格画好了会重渲染,这里跟着重读(海报按 URL 串判变)。
  useAgentLookPostersVersion()
  const posterMemberUrls = groupAvatarMembers.map((m) => identitiesById[m.id] ? displayAvatarUrl(m.avatar, m.id, `poster member "${m.name || m.id}"`, identitiesById[m.id].type) : null)

  // @@@group-avatar (#1164 G1) manager 选/拖图 → 校验(image/* + ≤5MB) → 上传 → 即时换头像。
  const handleAvatarFile = useCallback(async (file: File | null | undefined) => {
    if (!viewerIsManager || avatarUploading || !file) return
    if (!file.type.startsWith('image/')) { setActionError(t('group.settings.imageRequired')); return }
    if (file.size > 5 * 1024 * 1024) { setActionError(t('group.settings.imageTooLarge')); return }
    setAvatarUploading(true)
    setActionError(null)
    try {
      setAvatarUrl(await chatService.uploadGroupAvatar(chatId, file))
      toast(t('group.settings.avatarUpdated'), 'success')
    } catch (err) {
      setActionError(t('group.settings.avatarUploadFailed', { reason: String((err as Error)?.message ?? err) }))
    } finally {
      setAvatarUploading(false)
    }
  }, [avatarUploading, chatId, setAvatarUrl, t, toast, viewerIsManager])

  // @@@2070 群名就地编辑:只写 name。写失败要抛给 GroupNameInlineEdit —— 它据此留在编辑态并标出失败,
  // ❌ 当作改好了把输入框关掉(原因已由 update 放进错误行)。
  const handleRename = useCallback(async (next: string) => {
    if (!(await update({ name: next }))) throw new Error('group rename failed')
  }, [update])

  // #1730/#1731 离开/解散都 await 回调,失败进错误行;busy 防双击并发。确认改为抽屉内确认(与单聊清空同一形态)。
  const handleExit = useCallback(async () => {
    if (busy || !currentUserId || !settings) return
    setBusy(true)
    setActionError(null)
    try {
      if (viewerRole === 'owner') {
        await onDissolveGroup?.()
      } else if (onLeaveGroup) {
        await onLeaveGroup()
      } else {
        await chatService.removeGroupMember(chatId, currentUserId)
        await onReload()
      }
      setConfirmExit(false)
    } catch (err) {
      setActionError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [busy, chatId, currentUserId, onDissolveGroup, onLeaveGroup, onReload, settings, viewerRole])

  const openTextPage = useCallback((next: 'rules' | 'description') => {
    // 设置还没读到时不进编辑页:草稿会从空串起步,点「完成」就把库里原有的规则/描述清掉。
    if (!settings) return
    setSettingsError(null)
    setDraft((next === 'rules' ? settings.group_prompt : settings.description) ?? '')
    push(next)
  }, [push, setSettingsError, settings])

  const saveTextPage = useCallback(async () => {
    const value = draft.trim() || null
    const ok = await update(page === 'rules' ? { group_prompt: value } : { description: value })
    if (ok) pop()
  }, [draft, page, pop, update])

  const error = actionError ?? settingsError
  const errorLine = error ? <div role="alert" style={settingsErrorStyle}>{error}</div> : null
  const bodyStyle = mobileShell ? settingsMobileBodyStyle : settingsBodyStyle
  const canExit = !!settings && (viewerRole !== 'owner' || Boolean(onDissolveGroup))
  const groupName = settings?.name ?? chat.name ?? null

  const subHead = (title: ReactNode, action?: ReactNode) => <SettingsPageHead title={title} action={action} onBack={pop} onClose={mobileShell ? onClose : undefined} mobile={mobileShell} />
  let content: ReactNode
  if (page === 'members') {
    content = <MemberListPanel chatId={chatId} chatKind="group" snapshot={snapshot} error={snapshotError} onReload={onReload} onOpenUserChat={onOpenUserChat} onWhisper={onWhisper} head={subHead} />
  } else if (page === 'announcement') {
    content = <AnnouncementDrawer chatId={chatId} isAdmin={viewerIsManager} head={subHead} />
  } else if (page === 'manage' && settings) {
    content = (
      <>
        {subHead(t('group.settings.manage'))}
        <div style={bodyStyle}>
          <GroupSettingsManagePage
            chatId={chatId}
            settings={settings}
            totalMembers={totalMembers}
            inviteLink={inviteLink}
            onUpdate={update}
            onOpenPoster={() => setShowSharePoster(true)}
          />
          {errorLine}
        </div>
      </>
    )
  } else if (page === 'rules' || page === 'description') {
    const isRules = page === 'rules'
    const saved = isRules ? settings?.group_prompt : settings?.description
    content = (
      <>
        {subHead(isRules ? t('group.settings.rules') : t('group.settings.description'),
          viewerIsManager ? <Button variant="primary" size="sm" onClick={() => { void saveTextPage() }}>{t('common.done')}</Button> : undefined)}
        <div style={bodyStyle}>
          {viewerIsManager ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={isRules ? t('group.settings.rulesPlaceholder') : t('group.settings.descriptionPlaceholder')}
              aria-label={isRules ? t('group.settings.rules') : t('group.settings.description')}
              style={settingsTextareaStyle}
            />
          ) : (
            <div style={settingsReadOnlyBoxStyle}>
              {saved || (isRules ? t('group.settings.rulesUnset') : t('group.settings.descriptionUnset'))}
            </div>
          )}
          {errorLine}
        </div>
      </>
    )
  } else {
    const preview = unifiedMembers.slice(0, MEMBER_PREVIEW_COUNT)
    content = (
      <>
        {/* 桌面上群信息是一枚页签:它自己就是标题和 ×,只有二级页画返回;手机整页照旧左上返回 = 关。 */}
        {mobileShell ? <SettingsPageHead title={t('group.settings.title')} onClose={onClose} mobile /> : null}
        <div style={bodyStyle}>
          <div style={profileRowStyle}>
            {/* .gi 52px 群头像。@@@group-avatar (#1164 G1):manager 点击/拖入更换;非 manager 只读。 */}
            <div
              data-testid="group-avatar"
              title={viewerIsManager ? t('group.settings.changeAvatar') : undefined}
              onClick={viewerIsManager && !avatarUploading ? () => avatarInputRef.current?.click() : undefined}
              onDragOver={viewerIsManager ? (event) => { event.preventDefault(); setAvatarDragOver(true) } : undefined}
              onDragLeave={viewerIsManager ? () => setAvatarDragOver(false) : undefined}
              onDrop={viewerIsManager ? (event) => { event.preventDefault(); setAvatarDragOver(false); void handleAvatarFile(event.dataTransfer.files?.[0]) } : undefined}
              style={avatarDragOver ? avatarFrameDragStyle : viewerIsManager && !avatarUploading ? avatarFrameEditableStyle : avatarFrameStyle}
            >
              <Avatar variant="group" name={groupName ?? t('group.settings.groupFallback')} avatarUrl={settings?.avatar_url ?? null} memberAvatars={groupAvatarMembers} size={52} />
              {avatarUploading ? <div style={avatarUploadingStyle}>{t('group.settings.uploading')}</div> : null}
              {viewerIsManager ? (
                <input ref={avatarInputRef} type="file" accept="image/*" style={hiddenStyle}
                  onChange={(event) => { void handleAvatarFile(event.target.files?.[0]); event.target.value = '' }} />
              ) : null}
            </div>
            <div style={profileTextStyle}>
              <GroupNameRow chat={chat} name={groupName} canEdit={viewerIsManager && Boolean(settings)} onCommit={handleRename} />
              <div style={memberCountStyle}>{t('group.settings.memberCount', { count: totalMembers })}</div>
            </div>
          </div>

          <SettingsNavRow
            title={t('group.settings.members')}
            testId="group-settings-members"
            onClick={() => push('members')}
            value={(
              <>
                <span style={memberStackStyle}>
                  {preview.map((member) => (
                    <span key={member.id} style={memberStackItemStyle}>
                      <Avatar name={identitiesById[member.id]?.display_name ?? ''} avatarUrl={identitiesById[member.id]?.avatar ?? null} seed={member.id} size={24} />
                    </span>
                  ))}
                </span>
                {totalMembers}
              </>
            )}
          />
          <SettingsNavRow title={t('header.announcement')} testId="group-settings-announcement" onClick={() => push('announcement')} />
          <SettingsNavRow title={t('group.settings.rules')} testId="group-settings-rules" value={settings ? firstLine(settings.group_prompt) ?? t('group.settings.rulesUnset') : undefined} onClick={() => openTextPage('rules')} />
          <SettingsNavRow title={t('group.settings.description')} testId="group-settings-description" value={settings ? firstLine(settings.description) ?? t('group.settings.descriptionUnset') : undefined} onClick={() => openTextPage('description')} />
          {/* 邀请链接本身所有成员都能分享;管理者在「群管理」里看到同一块(连同开关)。 */}
          <MemberInviteLink chatId={chatId} inviteLink={!viewerIsManager && settings?.invite_link_enabled ? inviteLink : null} onOpenPoster={() => setShowSharePoster(true)} />
          {viewerIsManager && settings ? (
            <SettingsNavRow title={t('group.settings.manage')} testId="group-settings-manage" onClick={() => push('manage')} />
          ) : null}

          <div style={settingsSectionLabelStyle}>{t('group.settings.sectionChat')}</div>
          <ChatManagementActions
            activeChat={chat}
            appearance="settings"
            onClose={onClose}
            onClearMessages={onClearMessages}
            onOpenSearch={onOpenSearch}
            onSetNotificationLevel={onSetNotificationLevel}
            onTogglePinned={onTogglePinned}
          />

          {canExit ? (
            confirmExit ? (
              <div style={confirmStyle}>
                <p style={confirmTextStyle}>{viewerRole === 'owner' ? t('group.settings.dissolveConfirm') : t('group.settings.leaveConfirm')}</p>
                <div style={confirmActionsStyle}>
                  <Button variant="danger" size="sm" disabled={busy} style={confirmButtonStyle} onClick={() => { void handleExit() }}>
                    {viewerRole === 'owner' ? t('group.settings.dissolve') : t('group.settings.leave')}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} style={confirmButtonStyle} onClick={() => setConfirmExit(false)}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : (
              <div role="button" data-testid="group-settings-exit" style={leaveStyle} onClick={() => setConfirmExit(true)}>
                {viewerRole === 'owner' ? t('group.settings.dissolve') : t('group.settings.leave')}
              </div>
            )
          ) : null}
          {errorLine}
        </div>
      </>
    )
  }

  return (
    <>
      <SettingsPageFrame page={page}>{content}</SettingsPageFrame>
      {/* @@@445 群邀请海报;guard 含 invite_link_enabled:开关关掉时链接对加入无效,别让海报带死 QR。 */}
      {showSharePoster && settings?.invite_link_enabled && inviteLink ? (
        <SharePosterDialog
          title={resolveOrLoud(groupName, 'group share poster title')}
          subtitle={t('group.settings.posterSubtitle', { count: totalMembers })}
          qrValue={inviteLink}
          memberAvatarUrls={posterMemberUrls}
          totalMemberCount={totalMembers}
          qrCaption={t('group.settings.posterQrCaption')}
          ctaText={t('group.settings.posterCta')}
          onClose={() => setShowSharePoster(false)}
        />
      ) : null}
    </>
  )
}
