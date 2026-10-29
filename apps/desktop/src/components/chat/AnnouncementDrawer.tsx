import { useCallback, useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupAnnouncement } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { readDisplayIdentities } from '../../lib/identityReadAdapter'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { rendererLogger } from '../../lib/log'

const announcementLog = rendererLogger('chat/announcements')
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { formatCalendarDay } from '../../lib/calendarTime'
import { Avatar } from '../Avatar'
import { useChatStore } from '../../store/chatContext'

// @@@group-announcements (#986) — 群公告 drawer. Design: #announce-drawer.
// 只画内容;外壳与页头归宿主:群设置栈里是它的一页,⋯ 菜单开时是一个右栏。Admin-only post/delete; like/edit are visual stubs.

const styleStateCenter: React.CSSProperties = { padding: '24px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-body)' }
const panelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
const countStyle: CSSProperties = { fontWeight: 400, fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', marginLeft: 2 }
const styleInlineError: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--danger-fg)' }

export function AnnouncementDrawer({
  chatId,
  isAdmin,
  head,
}: {
  chatId: string
  isAdmin: boolean
  /** 页头归宿主画(群设置栈 / ⋯ 菜单开的右栏),这里只给标题。 */
  head: (title: ReactNode) => ReactNode
}): JSX.Element {
  const { t } = useTranslation('messaging')
  const { identitiesById, getImRepository } = useChatStore('identitiesById', 'getImRepository')
  const [announcements, setAnnouncements] = useState<GroupAnnouncement[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Composer state
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const fetchAnnouncements = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await chatService.getAnnouncements(chatId)
      setAnnouncements(rows)
      // 作者未必还在群里(退群后没有成员行,投影闭包不再为他索要身份):作者身份随公告一起提交,不去 identitiesById 里碰运气。
      // 身份读失败只记日志、公告照列 —— 名字缺了由 resolveOrLoud 在显示处响亮,不该把已读到的公告一并丢掉。
      await getImRepository()
        .then(async (repository) => repository.putIdentities(await readDisplayIdentities(rows.map((row) => row.authorId))))
        .catch((err: unknown) => announcementLog.error({ chatId, err }, 'commit announcement author identities failed'))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setLoading(false)
    }
  }, [chatId, getImRepository])

  useEffect(() => {
    void fetchAnnouncements()
  }, [fetchAnnouncements])

  const handlePost = useCallback(async () => {
    const text = draft.trim()
    if (!text || posting) return
    setPosting(true)
    setPostError(null)
    try {
      await chatService.postAnnouncement(chatId, text)
      setDraft('')
      setComposerOpen(false)
      await fetchAnnouncements()
    } catch (err) {
      setPostError(String((err as Error)?.message ?? err))
    } finally {
      setPosting(false)
    }
  }, [chatId, draft, fetchAnnouncements, posting])

  const handleDelete = useCallback(async (announcementId: string) => {
    const ok = window.confirm(t('announcement.deleteConfirm'))
    if (!ok) return
    try {
      await chatService.deleteAnnouncement(announcementId)
      await fetchAnnouncements()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }, [fetchAnnouncements, t])

  // @@@announcement-likes (#1115) — 乐观切换点赞，写后 refetch 对账真值（失败回滚）。
  const handleToggleLike = useCallback(async (ann: GroupAnnouncement) => {
    const nextLiked = !ann.likedByMe
    setAnnouncements((prev) => prev.map((a) =>
      a.id === ann.id
        ? { ...a, likedByMe: nextLiked, likeCount: a.likeCount + (nextLiked ? 1 : -1) }
        : a,
    ))
    try {
      await chatService.setAnnouncementLike(ann.id, nextLiked)
      await fetchAnnouncements()
    } catch (err) {
      // 回滚乐观更新
      setAnnouncements((prev) => prev.map((a) =>
        a.id === ann.id ? { ...a, likedByMe: ann.likedByMe, likeCount: ann.likeCount } : a,
      ))
      setError(String((err as Error)?.message ?? err))
    }
  }, [fetchAnnouncements])

  // @@@announcement-edit (#1115) — admin 改公告正文，写后 refetch；抛错给卡片内联编辑器处理。
  const handleEdit = useCallback(async (announcementId: string, content: string) => {
    await chatService.editAnnouncement(announcementId, content)
    await fetchAnnouncements()
  }, [fetchAnnouncements])

  // @@@announcement-pin (#1164 G3) — admin 切置顶/取消置顶，写后 refetch 重排（getAnnouncements 已 pinned 优先）。
  const handleTogglePin = useCallback(async (announcementId: string, nextPinned: boolean) => {
    try {
      await chatService.setAnnouncementPinned(announcementId, nextPinned)
      await fetchAnnouncements()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }, [fetchAnnouncements])

  return (
    <div data-testid={AUTOMATION_TEST_IDS.groupAnnouncementDrawer} style={panelStyle}>
      {head(
        <>
          {t('announcement.title')}
          {announcements.length > 0 ? (
            <span style={countStyle}>· {announcements.length}</span>
          ) : null}
        </>,
      )}

      {/* Body (.d-body) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 24px' }}>

        {/* 发布公告 button — admin only */}
        {isAdmin ? (
          <button
            type="button"
            data-testid={AUTOMATION_TEST_IDS.groupAnnouncementPostButton}
            onClick={() => { setComposerOpen(true); setDraft(''); setPostError(null) }}
            style={{
              width: '100%',
              background: 'var(--primary)',
              color: 'var(--primary-fg)',
              border: 'none',
              borderRadius: 'var(--radius-surface)',
              padding: 11,
              fontSize: 'var(--font-body)',
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: 16,
            }}
            // @@@state-ladder-mix 反馈交给 CSS(.gg-fill 就是实色填充钮的那份配方:
            // hover .88 / 按下 .78 / 禁用 .4)。以前用 onMouseEnter 直接改 DOM 的 style.opacity ——
            // 那样既没有按下态,也绕开了统一的时长与曲线,而且触屏上根本不触发。
            className="gg-fill"
          >
            {t('announcement.post')}
          </button>
        ) : null}

        {/* Inline composer */}
        {composerOpen && isAdmin ? (
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-surface)',
              padding: 13,
              marginBottom: 16,
              background: 'var(--bg-elevated)',
            }}
          >
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('announcement.contentPlaceholder')}
              rows={4}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 'var(--font-body)',
                color: 'var(--text-primary)',
                lineHeight: 1.65,
                fontFamily: 'inherit',
              }}
            />
            {postError ? (
              <div style={{ ...styleInlineError, marginTop: 4 }}>{postError}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setComposerOpen(false); setDraft(''); setPostError(null) }}
                style={{
                  height: 30,
                  padding: '0 12px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-document)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--font-body)',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={posting || !draft.trim()}
                onClick={() => void handlePost()}
                style={{
                  height: 30,
                  padding: '0 14px',
                  border: 'none',
                  borderRadius: 'var(--radius-document)',
                  background: posting || !draft.trim() ? 'var(--bg-elevated)' : 'var(--primary)',
                  color: posting || !draft.trim() ? 'var(--text-tertiary)' : 'var(--primary-fg)',
                  fontSize: 'var(--font-body)',
                  fontWeight: 600,
                  cursor: posting || !draft.trim() ? 'default' : 'pointer',
                }}
              >
                {posting ? t('announcement.posting') : t('announcement.post')}
              </button>
            </div>
          </div>
        ) : null}

        {/* Loading / error / empty states */}
        {loading && <div style={styleStateCenter}>{t('announcement.loading')}</div>}
        {!loading && error && <div style={styleInlineError}>{error}</div>}
        {!loading && !error && announcements.length === 0 && <div style={styleStateCenter}>{t('announcement.empty')}</div>}
        {/* Announcement cards (.ann-card) */}
        {!loading && !error && announcements.length > 0 && announcements.map((ann) => {
          return (
            <AnnouncementCard
              key={ann.id}
              announcement={ann}
              displayName={resolveOrLoud(identitiesById[ann.authorId]?.display_name, `announcement author ${ann.authorId}`)}
              displayAvatar={identitiesById[ann.authorId]?.avatar ?? null}
              authorId={ann.authorId}
              isAdmin={isAdmin}
              onDelete={() => void handleDelete(ann.id)}
              onToggleLike={() => void handleToggleLike(ann)}
              onTogglePin={() => void handleTogglePin(ann.id, !ann.pinned)}
              onEdit={(content) => handleEdit(ann.id, content)}
            />
          )
        })}
      </div>
    </div>
  )
}

function AnnouncementCard({
  announcement,
  displayName,
  displayAvatar,
  authorId,
  isAdmin,
  onDelete,
  onToggleLike,
  onTogglePin,
  onEdit,
}: {
  announcement: GroupAnnouncement
  displayName: string
  displayAvatar: string | null
  authorId: string
  isAdmin: boolean
  onDelete: () => void
  onToggleLike: () => void
  onTogglePin: () => void
  onEdit: (content: string) => Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState(announcement.content)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const beginEdit = () => {
    setEditDraft(announcement.content)
    setEditError(null)
    setEditing(true)
  }

  const saveEdit = async () => {
    const text = editDraft.trim()
    if (!text || savingEdit) return
    setSavingEdit(true)
    setEditError(null)
    try {
      await onEdit(text)
      setEditing(false)
    } catch (err) {
      setEditError(String((err as Error)?.message ?? err))
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <div
      data-testid={AUTOMATION_TEST_IDS.groupAnnouncementCard}
      data-announcement-id={announcement.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-surface)',
        padding: 13,
        marginBottom: 12,
      }}
    >
      {/* Card header (.ac-h): avatar + author name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        {/* Avatar (.ac-av): 24px circle */}
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 'var(--radius-capsule)',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {/* @@@2470 seed 用稳定的 authorId：默认脸才和消息面/通讯录的同一个人对得上（改名不变脸）。 */}
          <Avatar name={displayName} avatarUrl={displayAvatar} seed={authorId} size="sm" />
        </div>
        {/* Author name (.ac-name) */}
        <span
          style={{
            fontSize: 'var(--font-body)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {displayName}
        </span>
        {announcement.pinned ? (
          <span style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 600, flexShrink: 0 }}>
            {t('announcement.pinned')}
          </span>
        ) : null}
      </div>

      {/* Content (.ac-body) — inline editor when admin is editing (#1115) */}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            data-testid="announcement-edit-input"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            disabled={savingEdit}
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              fontSize: 'var(--font-body)',
              lineHeight: 1.65,
              fontFamily: 'inherit',
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-document)',
              padding: '7px 9px',
              outline: 'none',
            }}
          />
          {editError ? (
            <div style={styleInlineError}>{editError}</div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              type="button"
              onClick={() => { setEditing(false) }}
              disabled={savingEdit}
              style={{ height: 26, padding: '0 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-document)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', cursor: 'pointer' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="announcement-edit-save"
              onClick={() => void saveEdit()}
              disabled={savingEdit || !editDraft.trim()}
              style={{ height: 26, padding: '0 12px', border: 'none', borderRadius: 'var(--radius-document)', background: savingEdit || !editDraft.trim() ? 'var(--bg-elevated)' : 'var(--primary)', color: savingEdit || !editDraft.trim() ? 'var(--text-tertiary)' : 'var(--primary-fg)', fontSize: 'var(--font-body)', fontWeight: 600, cursor: savingEdit || !editDraft.trim() ? 'default' : 'pointer' }}
            >
              {savingEdit ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            fontSize: 'var(--font-body)',
            lineHeight: 1.65,
            color: 'var(--text-primary)',
            wordBreak: 'break-word',
          }}
        >
          {announcement.content}
        </div>
      )}

      {/* Footer (.ac-foot): date + action buttons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 10,
        }}
      >
        {/* Date (.ac-date) */}
        <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)' }}>
          {formatCalendarDay(announcement.createdAt)}
        </span>

        {/* Action buttons (.ac-acts) — appear on hover */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            opacity: hovered ? 1 : 0,
            transition: 'opacity var(--transition-fast)',
          }}
        >
          {/* Like — wired to chat.group_announcement_likes (#1115); all members can like. */}
          <button
            type="button"
            data-testid="announcement-like"
            aria-label={announcement.likedByMe ? t('announcement.unlike') : t('announcement.like')}
            aria-pressed={announcement.likedByMe}
            title={announcement.likedByMe ? t('announcement.unlike') : t('announcement.like')}
            onClick={onToggleLike}
            style={{
              height: 26,
              minWidth: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              border: 'none',
              borderRadius: 'var(--radius-document)',
              background: 'transparent',
              color: announcement.likedByMe ? 'var(--primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '0 5px',
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
              <path fill={announcement.likedByMe ? 'currentColor' : 'none'} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 22V11M2 13v7a2 2 0 0 0 2 2h11.4a2 2 0 0 0 1.97-1.65l1.2-7A2 2 0 0 0 16.6 11H13V7a2 2 0 0 0-2-2H9l-2 6" />
            </svg>
            {announcement.likeCount > 0 ? (
              <span data-testid="announcement-like-count" style={{ fontSize: 'var(--font-caption)', fontWeight: 600 }}>
                {announcement.likeCount}
              </span>
            ) : null}
          </button>

          {/* Pin / Unpin — admin only (#1164 G3). Pinned announcements sort to top (getAnnouncements). */}
          {isAdmin ? (
            <ActionIcon
              aria-label={announcement.pinned ? t('announcement.unpin') : t('announcement.pinned')}
              aria-pressed={announcement.pinned}
              title={announcement.pinned ? t('announcement.unpin') : t('announcement.pin')}
              data-testid="announcement-pin"
              onClick={onTogglePin}
              style={{ color: announcement.pinned ? 'var(--primary)' : 'var(--text-secondary)' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                <path fill={announcement.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z" />
              </svg>
            </ActionIcon>
          ) : null}

          {/* Edit — admin only; opens inline editor (#1115). */}
          {isAdmin ? (
            <ActionIcon aria-label={t('announcement.edit')} title={t('announcement.editTitle')} onClick={beginEdit}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="m14.36 4.08l1.56-1.56a2.19 2.19 0 0 1 3.1 3.1L17.46 7.1M14.36 4.08L7.83 10.6A4.42 4.42 0 0 0 6.7 12.5L5 19l6.5-1.7a4.42 4.42 0 0 0 1.9-1.13l6.54-6.53M14.36 4.08l3.1 3.09" />
              </svg>
            </ActionIcon>
          ) : null}

          {/* Delete — admin only, red */}
          {isAdmin ? (
            <ActionIcon
              aria-label={t('announcement.delete')}
              title={t('announcement.deleteTitle')}
              onClick={onDelete}
              style={{ color: 'var(--danger-fg)' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 6h18m-2 0l-1 14H6L5 6m5 0V4h4v2" />
              </svg>
            </ActionIcon>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ActionIcon({
  children,
  style,
  ...rest
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  'aria-label'?: string
  'aria-pressed'?: boolean
  'data-testid'?: string
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--radius-document)',
        background: 'transparent',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        padding: 0,
        ...style,
      }}
    >
      {children}
    </button>
  )
}
