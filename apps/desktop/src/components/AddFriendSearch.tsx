import { useCallback, useEffect, useState } from 'react'

import type { CSSProperties } from 'react'
import { useContactsStore } from '../store/contactsContext'
import { parseGuguQrPayload } from '@gugu/core/shared/qrPayload'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from './Avatar'
import { Sheet } from './ui/Sheet'
import { useToast } from './toastContext'
import { useTranslation } from 'react-i18next'
import { JoinGroupById } from './contacts/JoinGroupById'
import { SearchField } from './ui/SearchField'
import { useBackLayer } from './ui/sheetStack'

// @@@add-friend-unify (#加人链路统一) AddFriendSearch 是「搜索用户 → 发好友申请」的唯一实现，
// 同时被 ContactsPanel 的「添加联系人」路由（面板态，showHeader）与 ChatListPanel 的「+ 添加联系人」
// 弹窗（modal 壳，showHeader=false）复用。此前这套逻辑在 NewFriendsPanel 的搜索态与 AddFriendModal 里
// 各写了一遍（两套搜索框 + 两套结果行 + 两套发送口径），unify 后服务层与组件层都只有一条链路。

// ── header frame (panel mode) — 与 NewFriendsPanel 头部同款 ────────────────────
const headClass = 'afs-head window-drag-region flex shrink-0 items-center gap-[9px] px-4 pb-3 pt-4 text-[length:var(--font-title)] font-semibold [-webkit-app-region:no-drag]'
const backButtonClass = 'afs-back-btn gg-pressable -my-2.5 -ml-2.5 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] border-none bg-transparent p-0 text-[var(--text-primary)]'

// ── shared inline styles ──────────────────────────────────────────────────────
const styleFlexOverflow: CSSProperties = { flex: 1, overflow: 'hidden' }
const styleNameText: CSSProperties = {
  fontSize: 'var(--font-body)',
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const styleStatusLabel: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }

function BackChevron() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        d="m15 5-6 7 6 7"
      />
    </svg>
  )
}

function SearchBar({
  value,
  onChange,
  onSubmit,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  autoFocus?: boolean
}) {
  const { t } = useTranslation('contacts')
  return (
    <SearchField
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
      placeholder={t('friendSearch.searchPlaceholder')}
      autoFocus={autoFocus}
      clearLabel={t('friendSearch.clearSearch')}
      onClear={() => onChange('')}
    />
  )
}

// ── Search result item ────────────────────────────────────────────────────────

function SearchResultItem({
  user,
  alreadyFriend,
  alreadySent,
  onSend,
}: {
  user: ContactUser
  alreadyFriend: boolean
  alreadySent: boolean
  onSend: () => void
}) {
  const { t } = useTranslation('contacts')
  return (
    // @@@2322 P2.5 — 行 hover 收口 gg-row(--chat-row-hover 即 --hover 别名;100ms→--dur-fast 最近档)
    <div
      className="gg-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
      }}
    >
      <Avatar name={user.display_name} avatarUrl={user.avatar} seed={user.id} size="md" />
      <div style={styleFlexOverflow}>
        <div style={styleNameText}>
          {user.display_name}
          {user.type === 'agent' ? (
            <span style={{ marginLeft: 6, fontSize: 'var(--font-caption)', color: 'var(--accent)' }}>{t('common.agent')}</span>
          ) : null}
        </div>
        <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user.gugu_number == null ? t('friendSearch.guguNumberUnassigned') : t('friendSearch.guguNumberValue', { number: user.gugu_number })}
        </div>
      </div>
      {alreadyFriend && <span style={styleStatusLabel}>{t('friendSearch.alreadyFriend')}</span>}
      {!alreadyFriend && alreadySent && <span style={styleStatusLabel}>{t('friendSearch.sent')}</span>}
      {!alreadyFriend && !alreadySent && (
        <button
          onClick={onSend}
          style={{
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            border: 'none',
            borderRadius: 'var(--radius-document)',
            fontSize: 'var(--font-body)',
            padding: '4px 12px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {user.type === 'agent' ? t('friendSearch.requestToJoin') : t('friendSearch.add')}
        </button>
      )}
    </div>
  )
}

// ── AddFriendSearch (exported) ────────────────────────────────────────────────

// showHeader: 面板态渲染「添加联系人」头部（+ 移动端 onBack chevron）；弹窗态由 modal 自带头部 → 传 false。
// autoFocus: 挂载即聚焦搜索框（弹窗/点「添加联系人」入口都希望立刻能打字）。
// seed: 扫码得到的咕咕号 → 自动填入并搜索。
// onBack: 离开这一页（面板态的返回 / 弹窗的关闭）。申请发出后也走它：弹窗关掉、手机整页返回；
// 桌面面板没有可离开的地方（不传），只把搜索框和结果清空。
export function AddFriendSearch({
  seed,
  autoFocus,
  showHeader,
  onBack,
  mode = 'contact',
}: {
  seed?: { query: string; token: number } | null
  autoFocus?: boolean
  showHeader?: boolean
  onBack?: () => void
  // 「加人」与「加群」共用这一页,但**选哪一档发生在右上角那个加人按钮的菜单里**,
  // ❌ 页内不再放第二个开关(owner:「为什么不用这个按钮变多功能按钮」)。
  mode?: 'contact' | 'group'
}) {
  const { t } = useTranslation('contacts')
  useBackLayer(showHeader ? onBack : undefined) // 面板态(手机整页):安卓返回键 = 左上返回
  const {
    contacts,
    sentRequests,
    searchResults,
    isSearching,
    searchUsers,
    clearSearch,
    sendRequest,
  } = useContactsStore()

  const { toast } = useToast()
  const [query, setQuery] = useState('')
  // @@@1505 点「添加」先开附言 Dialog 收集申请附言（选填），再发申请（加好友先附言、再发申请）。
  const [pendingTarget, setPendingTarget] = useState<ContactUser | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const reportSearchError = useCallback((err: unknown) => {
    toast(t('friendSearch.searchFailed', { detail: String((err as Error)?.message ?? err) }), 'error')
  }, [t, toast])

  // @@@add-friend-unify 卸载时清搜索结果，避免下次打开残留上一次的命中（原 AddFriendModal 的清理口径）。
  useEffect(() => {
    return () => clearSearch()
  }, [clearSearch])

  function closeNoteDialog() {
    if (sending) return
    setPendingTarget(null)
    setNote('')
  }

  async function submitRequest() {
    if (!pendingTarget || sending) return
    setSending(true)
    try {
      await sendRequest(pendingTarget.id, note)
      setPendingTarget(null)
      setNote('')
      setQuery('')
      clearSearch()
      toast(t('friendSearch.sentToast'), 'success')
      onBack?.()
    } catch (err) {
      // @@@1505 反 fake success：发送失败（网络 / 重复申请约束等）必须让用户看到，弹窗保持打开可重试。
      toast(t('friendSearch.sendFailed', { detail: String((err as Error)?.message ?? err) }), 'error')
    } finally {
      setSending(false)
    }
  }

  const handleSearch = async () => {
    const q = query.trim()
    if (!q) {
      clearSearch()
      return
    }
    // @@@contact-qr-import (#537) - 粘贴一张联系人 QR 的文本时，解析出对方咕咕号再搜，
    // 让「加我」QR 不用扫码也能加。
    const qr = parseGuguQrPayload(q)
    await searchUsers(qr?.kind === 'contact' ? String(qr.gugu_number) : q).catch(reportSearchError)
  }

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (!v.trim()) clearSearch()
  }

  // @@@scan-seed (#537-A) - 扫码得到的咕咕号路由到这里：填入搜索框并跑搜索，命中的人带「添加」按钮。
  useEffect(() => {
    if (!seed) return
    setQuery(seed.query)
    void searchUsers(seed.query).catch(reportSearchError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, reportSearchError, searchUsers])

  const sentIds = new Set(sentRequests.map((r) => r.receiver_id))
  const friendIds = new Set(contacts.map((c) => c.id))
  const hasQuery = query.trim().length > 0

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {showHeader && (
        <div className={headClass}>
          {onBack ? (
            <button className={backButtonClass} aria-label={t('common.back')} onClick={onBack}>
              <BackChevron />
            </button>
          ) : null}
          {mode === 'group' ? t('joinGroup.title') : t('panel.addContact')}
        </div>
      )}

      {mode === 'group' ? <JoinGroupById headless={!showHeader} /> : (
      <>
      {/* Search bar */}
      <div style={{ padding: showHeader ? '0 16px 12px' : '12px 16px', flexShrink: 0 }}>
        <SearchBar value={query} onChange={handleQueryChange} onSubmit={handleSearch} autoFocus={autoFocus} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {hasQuery && isSearching && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 'var(--radius-circle)',
                border: '2px solid var(--accent)',
                borderTopColor: 'var(--bg-transparent)',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          </div>
        )}
        {hasQuery && !isSearching && searchResults.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}>
            {t('friendSearch.noResults')}
          </div>
        )}
        {hasQuery && !isSearching && searchResults.length > 0 && searchResults.map((u) => (
          <SearchResultItem
            key={u.id}
            user={u}
            alreadyFriend={friendIds.has(u.id)}
            alreadySent={sentIds.has(u.id)}
            onSend={() => { setNote(''); setPendingTarget(u) }}
          />
        ))}
      </div>
      </>
      )}

      {/* @@@1505 发好友申请附言 Dialog：点「添加」先来这填理由/打招呼（选填），再发申请。 */}
      {pendingTarget && (
        <Sheet
          onClose={closeNoteDialog}
          ariaLabel={t('friendSearch.requestTitle')}
          testId="friend-request-note-dialog"
          desktopWidth="min(400px, 100%)"
        >
          <div style={{ padding: '20px 20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar
                name={pendingTarget.display_name}
                avatarUrl={pendingTarget.avatar}
                seed={pendingTarget.id}
                size="md"
                isAgent={pendingTarget.type === 'agent'}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingTarget.display_name}</div>
                <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)' }}>{t('friendSearch.requestTitle')}</div>
              </div>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('friendSearch.notePlaceholder')}
              maxLength={200}
              rows={3}
              autoFocus
              style={{ width: '100%', resize: 'none', borderRadius: 'var(--radius-surface)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 'var(--font-body)', lineHeight: 1.5, padding: '10px 12px', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={closeNoteDialog}
                disabled={sending}
                style={{ borderRadius: 'var(--radius-capsule)', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', fontWeight: 500, padding: '8px 18px', cursor: sending ? 'default' : 'pointer' }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submitRequest()}
                disabled={sending}
                style={{ borderRadius: 'var(--radius-capsule)', border: 'none', background: 'var(--primary)', color: 'var(--primary-fg)', fontSize: 'var(--font-body)', fontWeight: 600, padding: '8px 20px', cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }}
              >
                {sending ? t('friendSearch.sending') : t('friendSearch.send')}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  )
}
