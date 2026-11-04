import { useTranslation } from 'react-i18next'
import { useSyncExternalStore } from 'react'
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge'
import { creditCount, formatCredits, isLowBalance, useSpendingPower } from '@/lib/billing'
import { openCreditSettings } from '@/lib/billing/settingsDestination'
import { platformModelIdFromOption } from '@/session/shared/platform-model-id'
import { Button } from '@/components/ui/Button'

/** Credit reminders belong to the composer of a conversation that spends credits. */
export function ConversationCreditNotice({ modelOptionId }: { modelOptionId?: string }) {
  return modelOptionId && platformModelIdFromOption(modelOptionId) ? <SpendingCreditNotice /> : null
}

function SpendingCreditNotice() {
  // The desktop task entry has a separate React root; AuthContext cannot cross it.
  const identity = useSyncExternalStore(subscribeIdentity, currentIdentity)
  return identity ? <AccountCreditNotice userId={identity.userId} /> : null
}

const currentIdentity = () => readSelfIdentityBridge()?.getSnapshot() ?? null
const subscribeIdentity = (listener: () => void) => readSelfIdentityBridge()?.subscribe(listener) ?? (() => {})

function AccountCreditNotice({ userId }: { userId: string }) {
  const user = { id: userId }
  const { power } = useSpendingPower(user)
  const { t } = useTranslation('settings')
  const credits = power?.spendable
  if (credits === undefined || !isLowBalance(credits)) return null
  return <div data-testid="conversation-credit-notice" role="status"
    style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', padding: '4px 0', overflowWrap: 'anywhere' }}>
    {t('lowBalance.remaining', { credits: formatCredits(credits), count: creditCount(credits) })}
    {' · '}
    <Button variant="ghost" size="sm" onClick={openCreditSettings} style={{ display: 'inline', minHeight: 0, border: 'none', background: 'transparent', padding: 0, color: 'inherit', font: 'inherit', textDecoration: 'underline' }}>
      {t('lowBalance.topUp')}
    </Button>
  </div>
}
