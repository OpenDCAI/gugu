import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { isNeedsYou } from '@gugu/core/shared/agentStatusPresentation'
import { useMobileShell } from '@/hooks/useMobileShell'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { followLink } from '@/lib/guguLinks'
import { Bell } from '@/lib/icons'
import { installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { setSidebarNotificationsOpen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { SectionLabel } from '../ui/SectionLabel'
import { rowKeyActivate } from '../contacts/contactsPanelStyles'
import { NOTIFICATION_LIST_SLOT_PREFIX, NOTIFICATION_TOGGLE_SLOT_PREFIX } from './NotificationSlot'
import { NeedsYouTaskRow } from './NeedsYouTaskRow'
import { markNeedsYouTaskSeen, useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'

installShellSlots()
const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const unread = (task: NeedsYouTask) => isNeedsYou(sessionPresentation(task.session, true), task.session.unseen === true)

/** One account-owned notification list, shared by the desktop workspace and phone Messages header. */
export const NeedsYouHost = observer(function NeedsYouHost({ onAttentionChange }: { onAttentionChange?: (attention: AgentAttention) => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks, count, attention, error } = useNeedsYouTasks()
  const open = useSidebarNotificationsOpen()
  useEffect(() => { onAttentionChange?.(attention) }, [onAttentionChange, attention])
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  const [marking, setMarking] = useState(0)
  const [readError, setReadError] = useState<string | null>(null)
  useEffect(() => { setReadError(null) }, [open])
  const markRead = useCallback(async (items: NeedsYouTask[]) => {
    setMarking(count => count + 1)
    const results = await Promise.allSettled(items.map(markNeedsYouTaskSeen))
    const errors = results.flatMap(result => result.status === 'rejected' ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : [])
    if (errors.length) setReadError(previous => [previous, ...errors].filter(Boolean).join('\n'))
    setMarking(count => count - 1)
  }, [])
  // Opening the list reads nothing: a failure is read when its task is opened (the task view's read bit) or by Mark all read.
  const unreadFailures = tasks.filter(task => unread(task) && sessionPresentation(task.session, true)?.tone === 'error')
  const title = t('settings.general.notifications', { ns: 'main' })
  return <>{[...entries].map(([key, element]) => {
    if (key.startsWith(NOTIFICATION_TOGGLE_SLOT_PREFIX)) return createPortal(
      <span className="relative inline-flex">
        <IconButton size={mobile ? 'md' : 'sm'} aria-label={title} title={title} aria-pressed={open} on={open} data-testid="notification-toggle" onClick={() => setSidebarNotificationsOpen(!open)}>
          <Bell />
        </IconButton>
        {count > 0 && <Chip tone="danger" shape="count" className="pointer-events-none absolute -right-1 -top-1" data-testid="notification-count">{count > 99 ? '99+' : count}</Chip>}
      </span>, element, key)
    if (!key.startsWith(NOTIFICATION_LIST_SLOT_PREFIX) || !open || slots?.getSlotLabel?.(key) !== 'active') return null
    return createPortal(<>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
        <SectionLabel>{title}</SectionLabel>
        {unreadFailures.length > 0 && <Button size="sm" variant="ghost" data-testid="notification-mark-all-read" disabled={marking > 0} onClick={() => { void markRead(unreadFailures) }}>{t('chatList.markAllRead', { ns: 'messaging' })}</Button>}
      </div>
      <div data-testid="notification-list" data-notification-scroll="" role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {tasks.map(task => {
          const openTask = () => followLink({ kind: 'session', sessionId: task.session.conversationId, deviceId: task.deviceId })
          return <NeedsYouTaskRow key={`${task.deviceId}/${task.session.conversationId}`} task={task} mobile={mobile} emphasis={unread(task)} onClick={openTask} onKeyDown={rowKeyActivate(openTask)} />
        })}
      </div>
    </>, element, key)
  })}</>
})
