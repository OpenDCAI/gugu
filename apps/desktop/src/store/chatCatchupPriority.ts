import { useEffect, useMemo, useRef } from 'react'
import { createAccountCatchupPriority } from '../lib/accountCatchupPriority'
import { platform } from '../platform'
import { rendererLogger } from '../lib/log'
import { ACCOUNT_REVISION_CURSOR_KEY } from '../lib/accountRevisionRuntime'
import { imSelectors, type AccountImRepository, type ImRepositorySnapshot } from '../lib/imRepository'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'

export function useChatCatchupPriority(accountId: string | null) {
  return useMemo(() => {
    if (!accountId || platform.kind !== 'capacitor') return null
    const priority = createAccountCatchupPriority()
    // Hold even if the revision subscription starts before the initial list effect.
    return { ...priority, initialReadCompleted: priority.begin() }
  }, [accountId])
}

export type ChatCatchupPriority = ReturnType<typeof useChatCatchupPriority>

/** Resume reads use the existing bounded owners, never a second message cache. */
export function useChatCatchupResume(
  priority: ChatCatchupPriority,
  refreshList: () => Promise<void>,
  refreshConversation: (chatId: string) => Promise<void>,
  activeChatId: { readonly current: string | null },
  getRepository: () => Promise<AccountImRepository>,
) {
  const current = useRef({ refreshList, refreshConversation, activeChatId, getRepository })
  current.current = { refreshList, refreshConversation, activeChatId, getRepository }
  useEffect(() => {
    if (!priority) return
    let disposed = false
    let running = false
    let stopNextRevision: () => void = () => undefined
    const resume = () => {
      if (disposed || running || document.visibilityState === 'hidden') return
      running = true
      const done = priority.begin()
      const { refreshList: list, refreshConversation: conversation, activeChatId: selected, getRepository: repository } = current.current
      const read = async () => {
        const repo = await repository()
        if (disposed) return
        stopNextRevision()
        const cursorOf = (snapshot: ImRepositorySnapshot) =>
          (imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(snapshot) as { revision: string } | undefined)?.revision ?? '0'
        const before = cursorOf(repo.snapshot())
        let unsubscribe: () => void = () => undefined
        const timeout = setTimeout(() => stopNextRevision(), 10_000)
        stopNextRevision = () => { clearTimeout(timeout); unsubscribe() }
        unsubscribe = repo.subscribe(cursorOf, (cursor) => {
          if (BigInt(cursor) <= BigInt(before)) return
          stopNextRevision()
          // hydrate at the first newly committed cursor revalidates all summaries.
          // At the old cursor it would be a free replay of the stale cached list.
          if (!disposed) void list().catch((error: unknown) => {
            if (!disposed && !isLifecycleCancellation(error)) rendererLogger('chat/catchup-priority').error({ error }, 'foreground summary refresh failed')
          })
        })
        // The selected tail is independent of the account journal. Let one page
        // commit afterwards, then summaries above get priority over the rest.
        if (selected.current) await conversation(selected.current)
      }
      void read().catch((error: unknown) => {
        if (!disposed && !isLifecycleCancellation(error)) rendererLogger('chat/catchup-priority').error({ error }, 'foreground catch-up read failed')
      }).finally(() => { running = false; done() })
    }
    const onVisible = () => { if (document.visibilityState === 'visible') resume() }
    const stop = platform.subscribeAppForeground(resume, (error) => {
      rendererLogger('chat/catchup-priority').error({ error }, 'foreground subscription failed')
    })
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', resume)
    return () => {
      disposed = true
      stopNextRevision()
      stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', resume)
    }
  }, [priority])
}
