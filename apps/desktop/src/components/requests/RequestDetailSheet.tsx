import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from '../Avatar'
import { Sheet } from '../ui/Sheet'

type RequestPeer = Pick<ContactUser, 'id' | 'display_name' | 'avatar' | 'gugu_number' | 'type'>

// 「新的请求」点开一行:这条请求是谁、说明、完整附言;底部与那一行同样的操作或状态。
export function RequestDetailSheet({ peer, context, message, footer, onClose }: {
  peer: RequestPeer
  context: string
  message: string | null
  footer: ReactNode
  onClose: () => void
}) {
  const { t } = useTranslation('contacts')
  return (
    <Sheet onClose={onClose} ariaLabel={peer.display_name} testId="request-detail" desktopWidth="min(400px, 100%)" mobileFitContent>
      <div className="flex min-h-0 flex-col gap-4 px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          <Avatar name={peer.display_name} avatarUrl={peer.avatar} seed={peer.id} size="lg" isAgent={peer.type === 'agent'} />
          <div className="min-w-0">
            <div className="truncate text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{peer.display_name}</div>
            {peer.gugu_number == null ? null : (
              <div className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{t('friendSearch.guguNumberValue', { number: peer.gugu_number })}</div>
            )}
          </div>
        </div>
        <div className="text-[length:var(--font-body)] text-[var(--text-secondary)]">{context}</div>
        {message ? (
          <p className="m-0 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--muted)] px-3 py-[10px] text-[length:var(--font-body)] text-[var(--text-primary)]">{message}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2 text-[length:var(--font-body)] text-[var(--text-tertiary)]">{footer}</div>
      </div>
    </Sheet>
  )
}
