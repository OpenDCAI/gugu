import { useState, useEffect, useCallback, useRef } from 'react'
import { useContactsStore } from '../store/contactsContext'
import { useChatStore } from '../store/chatContext'
import { useAuth } from '../store/auth'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { Avatar } from './Avatar'
import { useToast } from './toastContext'
import { useTranslation } from 'react-i18next'
import { SearchField } from './ui/SearchField'
import { rendererLogger } from '../lib/log'
import { messageForUser } from '../lib/userFacingError'

const groupChatLog = rendererLogger('chat/create-group')

interface CreateGroupChatModalProps {
  onClose: () => void
  onCreated: (chatId: string) => void
  /** 预填群名（如从工作台模板组建时传模板名）；传入即视作已锁定，选成员不再自动改名。 */
  initialName?: string
  initialSelectedIds?: string[]
}

// @@@1143 创建群聊 UI 按设计稿(「新建群聊」modal,
// `.ng-*` 类 + .na-modal):标题「新建群聊」/ 搜索 / 选中成员芯片条(.ng-selbar) / 分区联系人列表
// (个人 / Agent,.ng-sec + .ng-row + .ng-check;人在前,owner 10-05:agent 多时要翻过整段才找得到人) / 「创建群聊 · N 人」按钮。删除原臆造的 群名称输入框 /
// 筛选 tab / 内联报错 / 已选计数文案 / 取消按钮(设计稿仅右上 ✕ + 创建按钮)。
export function CreateGroupChatForm({ onClose, onCreated, initialName, initialSelectedIds = [] }: CreateGroupChatModalProps) {
  const { t } = useTranslation('contacts')
  const { contacts, contactsStatus, loadingContacts, refreshContacts } = useContactsStore()
  const { createGroupChat } = useChatStore('createGroupChat')
  const currentUserId = useAuth().user?.id ?? null
  const { toast } = useToast()

  // 建群是一个需要新鲜候选集的入口。联系人 revision 到达和创建弹窗关闭可能同一帧发生，
  // 因此打开时再取一次权威快照，避免成员选择器只看到旧的 ContactsProvider snapshot。
  const refreshEpochRef = useRef(0)
  const [refreshingContacts, setRefreshingContacts] = useState(true)
  const reloadContacts = useCallback(async () => {
    const epoch = ++refreshEpochRef.current
    setRefreshingContacts(true)
    try {
      await refreshContacts()
    } catch (error) {
      groupChatLog.error({ error: String(error) }, 'refresh contacts failed')
    } finally {
      if (epoch === refreshEpochRef.current) setRefreshingContacts(false)
    }
  }, [refreshContacts])
  useEffect(() => {
    void reloadContacts()
    return () => { refreshEpochRef.current += 1 }
  }, [reloadContacts])

  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds))
  // 群名内部维护(设计稿无群名输入框):未锁定时随选中成员自动命名;initialName(模板)锁定。
  const [groupName, setGroupName] = useState(() => initialName ?? contacts.filter((c) => initialSelectedIds.includes(c.id)).map((c) => c.display_name).join('、'))
  const groupNameLocked = Boolean(initialName)
  useEffect(() => {
    if (groupNameLocked || groupName || selected.size === 0) return
    const nextName = contacts
      .filter((contact) => selected.has(contact.id))
      .map((contact) => contact.display_name)
      .join('、')
    if (nextName) setGroupName(nextName)
  }, [contacts, groupName, groupNameLocked, selected])
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const toggleContact = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      if (!groupNameLocked) {
        setGroupName(contacts.filter((c) => next.has(c.id)).map((c) => c.display_name).join('、'))
      }
      return next
    })
  }, [contacts, groupNameLocked])

  const handleCreate = useCallback(async () => {
    if (selected.size < 1) {
      toast(t('createGroup.selectAtLeastOne'), 'info')
      return
    }
    const name = groupName.trim() || t('createGroup.fallbackName')
    setCreating(true)
    try {
      const chatId = await createGroupChat(name, Array.from(selected))
      onCreated(chatId)
    } catch (e) {
      toast(messageForUser(e, t('createGroup.failed')), 'error')
    } finally {
      setCreating(false)
    }
  }, [selected, groupName, createGroupChat, onCreated, t, toast])

  const q = query.trim().toLocaleLowerCase()
  const match = (c: ContactUser) =>
    !q || [c.display_name, c.alias ?? '', c.agent_type ?? ''].join(' ').toLocaleLowerCase().includes(q)
  // @@@1761 云 agent 禁入群(密钥短时凭据化+群协议基建补齐前的止血):选择器直接不出现。
  // isCloudAgentMarked 双标记判定——好友的云 agent 没有 agent_type 富化,单看它会漏(review F3)。
  // 只列自己名下的 agent:别人的 agent 要它的主人同意才能进群(product spec),建群时直接拉会被库拒。
  const agents = contacts.filter((c) => c.type === 'agent' && !isCloudAgentMarked(c) && c.owner_user_id === currentUserId && match(c))
  const humans = contacts.filter((c) => c.type !== 'agent' && match(c))
  const selectedContacts = contacts.filter((c) => selected.has(c.id))

  const createButtonLabel = creating
    ? t('createGroup.creating')
    : selected.size > 0
      ? t('createGroup.createWithCount', { count: selected.size })
      : t('createGroup.create')

  const renderRow = (contact: ContactUser) => {
    const isSelected = selected.has(contact.id)
    return (
      <div
        key={contact.id}
        data-contact-option={contact.id}
        onClick={() => toggleContact(contact.id)}
        // @@@2322 P2.5 — 行 hover 收口 gg-row(hover=--hover 同原值)
        className="gg-row"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 'var(--radius-control)', cursor: 'pointer' }}
      >
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" isAgent={contact.type === 'agent'} />
        <span style={{ flex: 1, fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {contact.display_name}
        </span>
        {/* .ng-check — 19px 圆形勾选框,选中=primary 底 + 白勾(设计稿 .ng-row.sel .ng-check) */}
        <span
          style={{
            width: 19, height: 19, borderRadius: 'var(--radius-capsule)', flexShrink: 0, display: 'grid', placeItems: 'center',
            border: isSelected ? '1.5px solid var(--primary)' : '1.5px solid var(--border-strong)',
            background: isSelected ? 'var(--primary)' : 'transparent',
            transition: 'background var(--dur-fast) var(--ease)',
          }}
        >
          {isSelected && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
              <path d="M1 4l3 3 5-6" stroke="var(--primary-fg)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </div>
    )
  }

  return (
      <div style={{ position: 'relative', padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        {/* 右上 ✕ 关闭(设计稿 .m-close) */}
        <button
          type="button"
          className="gg-pressable"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
          style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, border: 'none', background: 'transparent', color: 'var(--faint-fg)', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="m14.5 9.5l-5 5m0-5l5 5" /></g></svg>
        </button>

        <h3 style={{ fontSize: 'var(--font-heading)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>{t('createGroup.title')}</h3>

        {/* 搜索(设计稿 .search,muted 底 + 放大镜 + input) */}
        <SearchField
          className="mb-2"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('createGroup.searchPlaceholder')}
        />

        {/* 选中成员芯片条(设计稿 .ng-selbar);空=提示,有选=芯片(头像+名,可点删) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 26, alignItems: 'center', marginBottom: 8 }}>
          {selectedContacts.length === 0 ? (
            <span style={{ fontSize: 'var(--font-body)', color: 'var(--faint-fg)' }}>{t('createGroup.selectionHint')}</span>
          ) : (
            selectedContacts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleContact(c.id)}
                title={t('createGroup.removeMember', { name: c.display_name })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--muted)', borderRadius: 'var(--radius-capsule)', padding: '3px 9px 3px 3px', fontSize: 'var(--font-body)', color: 'var(--text-primary)', border: 'none', cursor: 'pointer' }}
              >
                <Avatar name={c.display_name} avatarUrl={c.avatar} seed={c.id} size="xs" isAgent={c.type === 'agent'} />
                {c.display_name}
              </button>
            ))
          )}
        </div>

        {/* 联系人列表(设计稿 .ng-list,分 个人 / Agent 两区) */}
        <div style={{ flex: 1, maxHeight: 300, overflowY: 'auto', margin: '0 -4px' }}>
          {contacts.length === 0 && (refreshingContacts || loadingContacts || contactsStatus === 'loading') && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--faint-fg)' }}>{t('common.loading')}</div>
          )}
          {contacts.length === 0 && !refreshingContacts && !loadingContacts && contactsStatus === 'error' && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--faint-fg)' }}>
              <div>{t('common.loadFailed')}</div>
              <button type="button" className="gg-pressable" onClick={() => { void reloadContacts() }} style={{ marginTop: 10, border: 0, background: 'transparent', color: 'var(--text-primary)', textDecoration: 'underline', cursor: 'pointer' }}>
                {t('common.retry')}
              </button>
            </div>
          )}
          {contacts.length === 0 && !refreshingContacts && !loadingContacts && contactsStatus !== 'error' && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--faint-fg)' }}>{t('createGroup.emptyContacts')}</div>
          )}
          {contacts.length > 0 && agents.length === 0 && humans.length === 0 && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--faint-fg)' }}>{t('createGroup.noResults')}</div>
          )}
          {humans.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--faint-fg)', padding: '9px 4px 3px' }}>{t('common.person')}</div>
              {humans.map(renderRow)}
            </>
          )}
          {agents.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--faint-fg)', padding: '9px 4px 3px' }}>{t('common.agent')}</div>
              {agents.map(renderRow)}
            </>
          )}
        </div>

        {/* 创建按钮(设计稿 .sbtn,右对齐;文案随选中数:创建群聊 · N 人) */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            style={{
              fontSize: 'var(--font-body)', fontWeight: 600, padding: '8px 18px', borderRadius: 'var(--radius-capsule)', border: 'none',
              background: 'var(--primary)', color: 'var(--primary-fg)',
              cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.7 : 1,
            }}
          >
            {createButtonLabel}
          </button>
        </div>
      </div>
  )
}
