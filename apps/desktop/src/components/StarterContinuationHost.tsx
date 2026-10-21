import { useEffect } from 'react'
import { useChatStore } from '../store/chatContext'
import { useToast } from './toastContext'
import { landPendingStarters } from '../lib/starterContinuation'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../lib/log'

/**
 * App-lifetime recovery host: land durable starter pointers whenever the authenticated chat tree mounts.
 * It never sends a message; a failed land keeps the pointer and is surfaced to the user.
 */
const starterLog = rendererLogger('agents/starter-continuation')

export function StarterContinuationHost({ active = true }: { active?: boolean }) {
  const { setDraft } = useChatStore('setDraft')
  const { toast } = useToast()
  const { t } = useTranslation('agents')

  useEffect(() => {
    if (!active) return
    let current = true
    void landPendingStarters(setDraft, undefined, undefined, () => current).catch((error) => {
      if (!current) return
      starterLog.error({ err: error instanceof Error ? error.message : String(error) }, 'starter recovery failed')
      // 这里原本按 `instanceof Error` 分岔,是为了决定「有没有 reason 可以拼在后面」。
      // reason 现在只进日志(上一行),两条分支的文案就一字不差了 —— 分岔连同 `…Detail` 一起删掉。
      toast(t('wizard.starterRecoveryFailed'), 'error')
    })
    return () => { current = false }
  }, [active, setDraft, toast, t])

  return null
}
