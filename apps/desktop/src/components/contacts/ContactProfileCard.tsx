import { OwnedAgentNameEditor } from './OwnedAgentNameEditor'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import {
  agentContactPresentation,
  agentContactRowToneColorClass,
  useShownAgentContactStatus,
  type AgentContactTone,
} from '../contactAgentTone'
import { Avatar } from '../Avatar'
import { AgentNeedsUserGlyph } from '../AgentNeedsUserGlyph'
import { CopyValue } from '../CopyValue'
import { Button } from '../ui/Button'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { MessageCircle, Pencil, Settings, Share, Trash, UserPlus, Zap } from '@/lib/icons'
import { useContactsStore } from '../../store/contactsContext'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import type { AgentRequestState } from './agentContactRequest'
export type { AgentRequestState } from './agentContactRequest'


// @@@ui-ruler 资料卡只吃尺子:头像 --avatar-xl(96)、名字 --font-size-xl、状态/号码 --font-body、
// 间距 4 的倍数、圆角 --r/--r-lg。原来的 120 头像、20px/13px 裸字号、30/14/17/9 间距全部收口。
const styles = {
  card:
    'gg-c-cpane-card flex flex-col items-center animate-[ggCNaPop_var(--dur-med)_var(--ease)_both]',
  avatarBase:
    'gg-c-cpane-av flex h-[var(--avatar-xl)] w-[var(--avatar-xl)] shrink-0 items-center justify-center overflow-hidden',
  avatarRound: 'rounded-full',
  name:
    'gg-c-cpane-name mt-5 flex items-center gap-2 text-xl font-semibold text-[var(--fg)]',
  bolt: 'gg-c-bolt flex shrink-0 text-[var(--agent-bolt)]',
  statusBase:
    'gg-c-cpane-status mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]',
  statusStandby: 'standby',
  // @@@5588 needs_user uses a Solar exclamation glyph; every other tone's color comes from the one table in
  // contactAgentTone (`--agent-tone-*`), the same the contacts row and the avatar badge use.
  statusDotBase: 'gg-c-cpane-status-dot h-[6px] w-[6px] shrink-0 rounded-full',
  guguNumber:
    'gg-c-cpane-gugu mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]',
  guguNumberLabel: 'gg-c-cpane-gugu-label text-[var(--text-secondary)]',
  originalName: 'max-w-[300px] truncate',
  // #5645 备注行:对齐微信「朋友资料 → 备注」——左标签、右一整条填写框。灰底与铅笔都只在悬停/编辑时出现:
  // 灰底的意思是「这块可以点进去改」,平时不该常驻(owner:颜色要有意义)。
  aliasRow: 'gg-c-cpane-alias mt-5 flex w-[360px] max-w-full items-center gap-4',
  aliasLabel: 'shrink-0 text-sm text-[var(--text-secondary)]',
  aliasBox:
    'group/alias relative flex min-w-0 flex-1 items-center rounded-[var(--radius-control)] bg-transparent transition-[background] duration-[var(--dur-fast)] hover:[background:var(--bg-secondary)] focus-within:[background:var(--bg-secondary)]',
  aliasInput:
    'h-9 w-full min-w-0 border-0 bg-transparent pl-3 pr-9 text-sm text-[var(--fg)] outline-none [font-family:inherit] placeholder:text-[var(--muted-fg)]',
  // owner:铅笔悬停才出现;正在输入时也收起(它只是「可编辑」的提示,不是按钮)
  aliasPen:
    'pointer-events-none absolute right-3 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/alias:opacity-100 group-focus-within/alias:opacity-0',
  actions: 'gg-c-cpane-acts -ml-3 mt-6 flex gap-1',
  // 2026-09-22 按 design.md:「icons dropped into tinted tiles」在反对清单上 —— 原来是三块 130px 带底色圆角砖。
  // 改成一行文字按钮:图标回到文字左边,8px 矩形、无常驻底色(只在 hover/press 出),层级靠字重与留白。
  // 原裁决:与 ContactsPanel 行同款的 --bg-secondary 色块。
  action:
    'gg-c-cact inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border-0 bg-transparent px-3 py-2 text-sm font-medium text-[var(--fg)] !transition-[background] !duration-[var(--dur-fast)] [font-family:inherit] hover:[background:var(--hover)] active:[background:var(--press)] disabled:cursor-default disabled:text-[var(--text-tertiary)]',
  delete:
    'gg-c-cpane-del !-ml-3 !mt-5 inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border-0 bg-transparent !px-3 !py-2 text-sm font-medium text-[var(--danger-fg)] [font-family:inherit] hover:bg-[var(--danger-tint)]',
} as const

const avatarClass = () => cn(styles.avatarBase, styles.avatarRound)

// @@@2175 与 ContactsPanel 行同款。降暗(.standby)= 静默态(pending/offline);其余不降暗(要显眼)。
const statusClass = (tone: AgentContactTone) =>
  cn(styles.statusBase, (tone === 'pending' || tone === 'offline') && styles.statusStandby)

const statusDotClass = (tone: AgentContactTone) => cn(styles.statusDotBase, agentContactRowToneColorClass(tone))

function displayName(contact: ContactUser): string {
  return contact.alias?.trim() || contact.display_name
}

// @@@2166① 文案与其它每一面同一张表(common:agentStatus.*):offline「待命」→「不在线」(owner 拍板)。
export function RemovedAgentContactBadge() {
  const { t } = useTranslation('contacts')
  return (
    // 颜色留在 inline:它是这个「已移除」状态面的可观测判据(单测按 style.color 判)。几何走类。
    <span
      data-agent-status-surface="contact-index"
      className="inline-flex items-center gap-1 text-xs"
      style={{ color: 'var(--danger-fg)' }}
    >
      <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-current" />
      {t('profile.removed')}
    </span>
  )
}

export function AgentContactProfileCard({
  contact,
  onSwitchToChat,
  onShare,
  onSettings,
  onDelete,
  requestState,
  onRequest,
  onOpenGroup,
}: {
  contact: ContactUser
  onSwitchToChat?: () => void
  onShare?: () => void
  onSettings?: () => void
  onDelete?: () => void
  requestState?: AgentRequestState | null
  onRequest?: () => void
  onOpenGroup?: () => void
}) {
  const { t } = useTranslation('contacts')
  const { status, presence } = useAgentDisplayStatus(contact.id)
  const { allowsLiveActions } = agentContactPresentation(status)
  const { tone, label: statusLabel } = useShownAgentContactStatus(contact.id, status, presence.presentation) // #7199 收回着 ≠ 不在线
  const requestLabel = requestState === 'joined'
    ? onOpenGroup ? t('commonGroups.open') : t('commonGroups.joined')
    : requestState === 'requested'
      ? t('commonGroups.requested')
      : requestState === 'requesting'
        ? t('commonGroups.requesting')
        : t('commonGroups.requestJoin')
  const hasOwnedActions = Boolean(onSwitchToChat || onShare || onSettings)
  return (
    <div className={styles.card}>
      <div className={avatarClass()}>
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={96} isAgent />
      </div>
      <OwnedAgentNameEditor key={contact.id} agentId={contact.id} name={contact.display_name} ownerUserId={contact.owner_user_id} status={status} className={styles.name}>
        {contact.display_name}
        <span className={styles.bolt}><Zap size={13} /></span>
      </OwnedAgentNameEditor>
      {tone ? (
        <div className={statusClass(tone)}>
          {tone === 'needs_user' ? (
            <AgentNeedsUserGlyph size={8} />
          ) : (
            <span className={statusDotClass(tone)} aria-hidden="true" />
          )}
          {statusLabel}
        </div>
      ) : null}
      {allowsLiveActions ? (
        hasOwnedActions ? <div className={styles.actions}>
          {allowsLiveActions && onSwitchToChat ? (
            <button
              type="button"
              className={styles.action}
              data-testid={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}
              onClick={onSwitchToChat}
            >
              <MessageCircle size={19} />
              {t('common.sendMessage')}
            </button>
          ) : null}
          {/* @@@1990 owner 门控与「删除」同款:handler 缺席即不渲染——分享 RPC(share_agent)与
              Agent 设置都是 owner-only,非 owner 渲染出来就是必撞 not-owned 的死按钮(无权就不给入口)。 */}
          {onShare ? (
            <button type="button" className={styles.action} onClick={onShare}>
              <Share size={19} />
              {t('common.share')}
            </button>
          ) : null}
          {onSettings ? (
            <button type="button" className={styles.action} onClick={onSettings}>
              <Settings size={19} />
              {t('common.settings')}
            </button>
          ) : null}
        </div> : null
      ) : null}
      {requestState ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant={requestState === 'available' ? 'primary' : 'ghost'}
            size="sm"
            className="min-w-[130px]"
            data-testid="contact-shared-agent-primary-action"
            disabled={requestState === 'joined' ? !onOpenGroup : requestState !== 'available' || !onRequest}
            onClick={requestState === 'joined' ? onOpenGroup : requestState === 'available' ? onRequest : undefined}
          >
            {requestState === 'joined' ? <MessageCircle size={19} /> : <UserPlus size={19} />}
            {requestLabel}
          </Button>
        </div>
      ) : null}
      {allowsLiveActions && onDelete ? (
        <button type="button" className={styles.delete} onClick={onDelete}>
          <Trash size={14} />
          {t('contextMenu.deleteAgent')}
        </button>
      ) : null}
    </div>
  )
}

// #5645 备注编辑(微信同款):点进灰框直接改,回车/失焦保存,Esc 还原,80 字上限(= 库约束)。
// 直接读 contacts store 而不走 props:宿主 ContactsPanel 行数被 CI 冻结,MemberProfilePopover 同款。
export function PersonAliasField({ contact }: { contact: ContactUser }) {
  const { t } = useTranslation('contacts')
  const { updateContactAlias } = useContactsStore()
  const saved = contact.alias?.trim() ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(contact.alias?.trim() ?? '') }, [contact.id, contact.alias])

  const save = async () => {
    const next = draft.trim()
    if (next === saved || saving) return
    setSaving(true)
    try { await updateContactAlias(contact.id, next) } finally { setSaving(false) }
  }

  return (
    <div className={styles.aliasRow}>
      <label className={styles.aliasLabel} htmlFor="contact-alias-input">{t('profile.alias')}</label>
      <div className={styles.aliasBox}>
        <input
          id="contact-alias-input"
          data-testid={AUTOMATION_TEST_IDS.contactsDetailAliasInput}
          className={styles.aliasInput}
          value={draft}
          disabled={saving}
          maxLength={80}
          placeholder={t('profile.notSet')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(saved)
          }}
        />
        <Pencil size={14} className={styles.aliasPen} />
      </div>
    </div>
  )
}

export function PersonContactProfileCard({
  contact,
  onSwitchToChat
}: {
  contact: ContactUser
  onSwitchToChat?: () => void
}) {
  const { t } = useTranslation('contacts')
  const hasAlias = Boolean(contact.alias?.trim())
  return (
    <div className={styles.card}>
      <div className={avatarClass()}>
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={96} />
      </div>
      <div className={styles.name}>{displayName(contact)}</div>
      {hasAlias ? (
        <div className={styles.guguNumber} data-testid={AUTOMATION_TEST_IDS.contactsDetailOriginalName}>
          <span className={styles.guguNumberLabel}>{t('profile.originalName')}</span>
          <span className={styles.originalName}>{contact.display_name}</span>
        </div>
      ) : null}
      <div className={styles.guguNumber}>
        <span className={styles.guguNumberLabel}>{t('common.guguNumber')}</span>
        {contact.gugu_number == null ? (
          <span>{t('common.unassigned')}</span>
        ) : (
          <CopyValue value={String(contact.gugu_number)} message={t('common.copiedGuguNumber')} />
        )}
      </div>
      <PersonAliasField contact={contact} />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          data-testid={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}
          onClick={onSwitchToChat}
        >
          <MessageCircle size={19} />
          {t('common.sendMessage')}
        </button>
      </div>
    </div>
  )
}
