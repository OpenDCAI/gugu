// #2118 — 联系人分区的「加载真值」渲染,从 ContactsPanel 抽出(冻结 god 文件不可增行 + 复用/一致性)。
// 铁律 fail-loud:空态 CTA 只在**成功的权威快照为空**时出现;idle/loading 不闪假空,error 必须显失败(可重试),
// 绝不把「加载中/加载失败」伪装成「没有对象」。桌面三段侧栏与移动壳共用同一套判定。
import type React from 'react'
import { Button } from '../ui/Button'
import { useContactsStore, type ContactsLoadStatus } from '../../store/contactsContext'
import { useChatStore } from '../../store/chatContext'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { useTranslation } from 'react-i18next'

/* 三个分区的空态 CTA 竖着排在一列窄边栏里，各自按文字长度收缩就是三种宽度。
   用共享 <Button> 拿到统一的高度/字号/圆角，再给一个共同的最小宽度让三者对齐。 */
const ctaStyle: React.CSSProperties = { minWidth: 104 }
/* 无框文本动作。padding 撑到 44px 命中区、再用等量负 margin 抵消占位 ——
   移动壳（<720px）要求触控目标 ≥44px，而这里视觉上必须仍是「一行字」，不能真占 44px 高。
   ❌ 别写成 padding:0：那样命中区只有文字本身那 18px，手指点不中。 */
const linkCtaStyle: React.CSSProperties = {
  minHeight: 44, padding: '13px 8px', margin: '-13px -8px',
  color: 'var(--text-primary)', textDecoration: 'underline', textUnderlineOffset: 3,
}

const captionStyle: React.CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-secondary)', lineHeight: 'var(--lh-body)' }

function StateWrap({ align, children, row }: { align: 'start' | 'center'; children: React.ReactNode; row?: boolean }) {
  const centered = align === 'center'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: row && !centered ? 'row' : 'column',
        flexWrap: 'wrap',
        alignItems: row && !centered ? 'baseline' : (centered ? 'center' : 'flex-start'),
        justifyContent: row && !centered ? 'flex-start' : 'center',
        gap: row && !centered ? 10 : 8,
        padding: centered ? '32px 16px' : '6px 8px 10px',
        textAlign: centered ? 'center' : 'left',
      }}
    >
      {children}
    </div>
  )
}

/** 空分区的空状态文案 + 复用现有入口的下一步 CTA(个人→添加联系人 / 群组→创建群聊)。 */
export interface ContactsSectionCta {
  caption: string
  actionLabel: string
  onAction: () => void
  testId?: string
  actionTestId?: string
}

export function ContactsSectionEmpty({ caption, actionLabel, onAction, testId, actionTestId, align = 'start' }: ContactsSectionCta & { align?: 'start' | 'center' }) {
  return (
    <StateWrap align={align} row>
      <span data-testid={testId} style={captionStyle}>{caption}</span>
      <Button variant="ghost" size="sm" data-testid={actionTestId} onClick={onAction} style={linkCtaStyle}>
        {actionLabel}
      </Button>
    </StateWrap>
  )
}

/**
 * 分区加载真值渲染。返回 null = 「ready 且非空」→ 由调用方渲染列表行。其余:
 *  idle/loading → 加载态(不出空态 CTA,防首帧闪假空);
 *  error → 失败态 + 可选重试(fail-loud,不冒充空);
 *  ready + 空 → 空态 CTA(有 cta 时)或纯文案(emptyLabel)。搜索无结果不走这里(ContactSearch 自己给一行)。
 */
export function ContactsSectionState({
  status,
  isEmpty,
  cta,
  emptyLabel,
  onRetry,
  align = 'start',
}: {
  status: ContactsLoadStatus
  isEmpty: boolean
  cta?: ContactsSectionCta | null
  emptyLabel?: string
  onRetry?: () => void
  align?: 'start' | 'center'
}): React.ReactElement | null {
  const { t } = useTranslation('contacts')
  if (status === 'idle' || status === 'loading') {
    return <StateWrap align={align}><span style={captionStyle}>{t('common.loading')}</span></StateWrap>
  }
  if (status === 'error') {
    return (
      <StateWrap align={align}>
        <span style={captionStyle}>{t('common.loadFailed')}</span>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry} style={ctaStyle}>{t('common.retry')}</Button>
        ) : null}
      </StateWrap>
    )
  }
  // status === 'ready'(权威快照)
  if (!isEmpty) return null
  if (cta) return <ContactsSectionEmpty {...cta} align={align} />
  if (emptyLabel) return <StateWrap align={align}><span style={captionStyle}>{emptyLabel}</span></StateWrap>
  return null
}

// 预接线:个人分区加载真值(从 store 读 contactsStatus + 重试),ContactsPanel 只传 isEmpty/onAddContact,
// 不再 prop-drill 状态(冻结 god 文件不可增行)。onAddContact 缺省(标签过滤视图)→ 回退纯文案「暂无联系人」。
export function ContactsPersonSectionState({ isEmpty, onAddContact, align = 'start' }: {
  isEmpty: boolean
  onAddContact?: () => void
  align?: 'start' | 'center'
}) {
  const { t } = useTranslation('contacts')
  const { contactsStatus, refreshContacts } = useContactsStore()
  return (
    <ContactsSectionState
      status={contactsStatus}
      isEmpty={isEmpty}
      onRetry={() => { void refreshContacts() }}
      align={align}
      emptyLabel={t('panel.noContacts')}
      cta={onAddContact ? { caption: t('panel.noContactsYet'), actionLabel: t('panel.addContact'), onAction: onAddContact, testId: AUTOMATION_TEST_IDS.contactsPersonEmpty, actionTestId: AUTOMATION_TEST_IDS.contactsPersonEmptyAction } : null}
    />
  )
}

// Agent 分区。与个人分区同源(agentContacts 是 contacts 里 type==='agent' 的子集)→ 复用 contactsStatus。
// 补这个分区的理由:改之前它空着时**什么都不渲染** —— 另外两个分区都有「还没有 X + 下一步」,
// 唯独 Agent 留一片白。用户看不出是「还没建」还是「没加载出来」,而 Agent 恰恰是这个产品的主角。
export function ContactsAgentSectionState({ isEmpty, onCreateAgent, align = 'start' }: {
  isEmpty: boolean
  onCreateAgent?: () => void
  align?: 'start' | 'center'
}) {
  const { t } = useTranslation('contacts')
  const { contactsStatus, refreshContacts } = useContactsStore()
  return (
    <ContactsSectionState
      status={contactsStatus}
      isEmpty={isEmpty}
      onRetry={() => { void refreshContacts() }}
      align={align}
      emptyLabel={t('panel.noAgents')}
      cta={onCreateAgent ? { caption: t('panel.noAgentsYet'), actionLabel: t('panel.createAgent'), onAction: onCreateAgent, testId: AUTOMATION_TEST_IDS.contactsAgentEmpty, actionTestId: AUTOMATION_TEST_IDS.contactsAgentEmptyAction } : null}
    />
  )
}

// 预接线:群组分区加载真值(群来自会话投影:从 store 读 groupChatsStatus,重试 = 重读投影)。
export function ContactsGroupSectionState({ isEmpty, onCreateGroup, align = 'start' }: {
  isEmpty: boolean
  onCreateGroup?: () => void
  align?: 'start' | 'center'
}) {
  const { t } = useTranslation('contacts')
  const { groupChatsStatus } = useContactsStore()
  const { refreshChats } = useChatStore('refreshChats')
  return (
    <ContactsSectionState
      status={groupChatsStatus}
      isEmpty={isEmpty}
      onRetry={() => { void refreshChats() }}
      align={align}
      emptyLabel={t('panel.noGroups')}
      cta={onCreateGroup ? { caption: t('panel.noGroupsYet'), actionLabel: t('panel.createGroup'), onAction: onCreateGroup, testId: AUTOMATION_TEST_IDS.contactsGroupEmpty, actionTestId: AUTOMATION_TEST_IDS.contactsGroupEmptyAction } : null}
    />
  )
}
