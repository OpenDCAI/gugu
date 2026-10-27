import { useTranslation } from 'react-i18next'
import { messageForUser } from '@/lib/userFacingError';
import { useEffect } from 'react'
import { useChatStore } from '../store/chatContext'
import { useToast } from './toastContext'
import { landPendingStarters } from '../lib/starterContinuation'
import { rendererLogger } from '../lib/log'

/**
 * App-lifetime recovery host: land durable starter pointers whenever the authenticated chat tree mounts.
 * It never sends a message; a failed land keeps the pointer and is surfaced to the user.
 */
const starterLog = rendererLogger('agents/starter-continuation')

export function StarterContinuationHost({ active = true }: { active?: boolean }) {
  const { writeDraft } = useChatStore('writeDraft')
  const { toast } = useToast()
  const { t } = useTranslation('agents')

  useEffect(() => {
    if (!active) return
    let current = true
    void landPendingStarters(writeDraft, undefined, undefined, () => current).catch((error) => {
      if (!current) return
      starterLog.error({ err: error instanceof Error ? error.message : String(error) }, 'starter recovery failed')
      toast(t('wizard.starterRecoveryFailed'), 'error', messageForUser(error))
    })
    return () => { current = false }
  }, [active, writeDraft, toast, t])

  return null
}
