import { Avatar } from './Avatar'
import { Popover } from './ui/Popover'
import { useTranslation } from 'react-i18next'

// @@@1345 已读回执弹层：点击消息气泡的进度圆环 → 弹「X 已读 | Y 未读」+ 左右两列头像名单。
// 数据由 ChatAreaPanel 用 deriveReadReceipt 的 readerIds/recipientIds 映射成员档案后传入（弹层不取数）。
export interface ReadReceiptMember {
  id: string
  displayName: string
  avatar: string | null
  isAgent: boolean
}

function MemberRow({ member }: { member: ReadReceiptMember }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', minWidth: 0 }}>
      <Avatar name={member.displayName} avatarUrl={member.avatar} seed={member.id} isAgent={member.isAgent} size="sm" />
      <span
        style={{
          fontSize: 'var(--font-body)',
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {member.displayName}
      </span>
    </div>
  )
}

function MemberColumn({ title, count, members, emptyText }: {
  title: string
  count: number
  members: ReadReceiptMember[]
  emptyText: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--text-secondary)', padding: '0 4px 6px' }}>
        {title} {count}
      </div>
      {members.length === 0 ? (
        <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', padding: '5px 4px' }}>{emptyText}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 240, overflowY: 'auto' }}>
          {members.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ReadReceiptPopover({
  anchor,
  readers,
  unreaders,
  testId,
  onClose,
}: {
  /** 已读圆环按钮本身;Base UI 随列表滚动重量它。 */
  anchor: Element
  readers: ReadReceiptMember[]
  unreaders: ReadReceiptMember[]
  testId?: string
  onClose?: () => void
}) {
  const { t } = useTranslation('messaging')
  const width = 280
  const gap = 8
  // 锚在已读圆环按钮上（本人气泡下沿）→ Base UI 负责视口碰撞与 Escape/outside press。

  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose?.()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={gap}
          collisionPadding={8}
          collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <Popover.Popup
            role="dialog"
            aria-label={t('message.receipt.title')}
            data-testid={testId}
            style={{
              width,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              boxShadow: 'var(--shadow-popover-strong)',
              color: 'var(--text-primary)',
              padding: 12,
            }}
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <MemberColumn title={t('message.read')} count={readers.length} members={readers} emptyText={t('message.receipt.noneRead')} />
              <div style={{ width: 1, background: 'var(--border-subtle)', alignSelf: 'stretch' }} />
              <MemberColumn title={t('message.unread')} count={unreaders.length} members={unreaders} emptyText={t('message.receipt.allRead')} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
