import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useMobileShell } from '@/hooks/useMobileShell'
import { useChatStore } from '@/store/chatContext'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { SettlementCard } from '@/mobile/agent-watch/TimelineView'
import { SessionAvatar } from '@/mobile/agent-watch/StatusGlyph'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { agentStatusText } from '@/lib/agentStatusText'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { phoneTimelineClient } from '@/mobile/local-agent/phoneTimelineClient'
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { AgentNeedsUserGlyph } from '../AgentNeedsUserGlyph'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { SectionLabel } from '../ui/SectionLabel'
import { Sheet } from '../ui/Sheet'
import { PaneHeader } from '../ui/Pane'
import { rowKeyActivate } from '../contacts/contactsPanelStyles'
import { closeInShell } from '@/session/renderer/features/extensions/install-consent'
import { appInstallAskOf } from '@/session/shared/extensions/host-actions'
import { observer } from 'mobx-react-lite'
import { followLink } from '@/lib/guguLinks'
import { ArrowRight, X } from '@/lib/icons'
import { installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { NEEDS_YOU_LIST_SLOT_PREFIX, NEEDS_YOU_SLOT_PREFIX } from './NeedsYouSlot'
import { NeedsYouTaskRow } from './NeedsYouTaskRow'
import { readPhoneAppView, onPhoneAppState } from '../appSlot/phoneAppState'
import { sessionPageOnScreen, sessionPagesOnScreen } from '@/session/renderer/app/sessions-on-screen'
import { getSessionView } from '@/session/renderer/features/sessions/stores/session-selectors'
import { isEmbedVisible, subscribeEmbedVisibility } from '@/session/renderer/lib/portal-container'
import { useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@/mobile/agent-watch/agent-watch.css'

installShellSlots()

const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()

function taskKey(task: NeedsYouTask): string {
  return `${task.deviceId}/${task.session.conversationId}`
}

/** One actionable entrance to the existing pending settlements, over every shell page. */
export const NeedsYouHost = observer(function NeedsYouHost({ enabled, onAttentionChange }: { enabled: boolean; onAttentionChange?: (attention: AgentAttention) => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks: waiting, attention, error } = useNeedsYouTasks()
  useEffect(() => { onAttentionChange?.(attention) }, [onAttentionChange, attention])
  const phone = useSyncExternalStore(onPhoneAppState, readPhoneAppView)
  const embedded = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible)
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  // Reuse the actual task route and active pane entries. A file/App tab has no approval card.
  const shownSessions = mobile
    ? phone.panes.some(pane => pane.activeTab?.kind === 'session') ? [phone.activeSessionId] : []
    : embedded ? sessionPagesOnScreen().filter(page => sessionPageOnScreen(page.sessionId) && getSessionView(page.projectId, page.sessionId)?.paneLayout.groups.some(({ pane }) => {
      const entry = pane.activeEntry
      return (entry?.kind === 'session' || entry?.kind === 'acp-chat') && (entry.state as { sessionId?: string }).sessionId === page.sessionId
    })).map(page => page.sessionId) : []
  const tasks = waiting.filter(task => !(task.session.supported && shownSessions.includes(task.session.conversationId)))
  const { identitiesById } = useChatStore('identitiesById')
  const [opened, setOpened] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const task = tasks.find(task => taskKey(task) === selected) ?? (tasks.length === 1 ? tasks[0] : undefined)
  const shown = opened && tasks.length > 0
  // Closing after the last wait also resets the next visit, without retaining a hidden dialog.
  if (opened && (!enabled || tasks.length === 0)) setOpened(false)
  // #901 The entry and phone rows are opt-in; the rail attention above stays live either way.
  if (!enabled) return null
  return <>
    {mobile && [...entries].filter(([key]) => key.startsWith(NEEDS_YOU_LIST_SLOT_PREFIX)).map(([key, element]) => createPortal(waiting.map(item => {
      const open = () => { followLink({ kind: 'session', sessionId: item.session.conversationId }) }
      return <NeedsYouTaskRow key={taskKey(item)} task={item}
        onClick={open} onKeyDown={rowKeyActivate(open)} />
    }), element, key))}
    {tasks.length > 0 && [...entries].filter(([key]) => key.startsWith(NEEDS_YOU_SLOT_PREFIX)).map(([key, element]) => createPortal(<div role="status" aria-live="polite" data-chat-dock-obstacle="">
      <Button data-testid="needs-you-trigger" onClick={() => setOpened(true)} aria-haspopup="dialog" aria-expanded={shown}>
        <AgentNeedsUserGlyph size={16} />{t('needsYou.count', { count: tasks.length })}
      </Button>
    </div>, element, key))}
    {shown && <Sheet fullScreenMobile testId="needs-you-sheet" ariaLabel={t('needsYou.title')} onClose={() => setOpened(false)} zIndex="var(--z-settings-modal)" desktopWidth="520px">
      <PaneHeader title={<h2 className="gg-pane-title">{t('needsYou.title')}<span className="!ml-2 text-[length:var(--font-body)] font-normal text-[var(--text-secondary)]">{tasks.length}</span></h2>} mobile={mobile} divider actions={<IconButton aria-label={t('dialog.close')} onClick={() => setOpened(false)}><X size={18} aria-hidden="true" /></IconButton>} />
      <div className="flex min-h-0 flex-col gap-3 overflow-auto !p-4">
        {error && <p role="alert">{error}</p>}
        <div>
          <SectionLabel>{t('needsYou.waitingTasks')}</SectionLabel>
          {tasks.map(item => {
            const agentName = identitiesById[item.session.agent?.userId ?? '']?.display_name
            const presentation = sessionPresentation(item.session, true)
            const select = () => setSelected(taskKey(item))
            return <ListRow key={taskKey(item)} mobile={mobile} role="button" tabIndex={0}
              data-testid="needs-you-task" selected={task === item} aria-pressed={task === item}
              onClick={select} onKeyDown={rowKeyActivate(select)} title={item.session.title}
              leading={<SessionAvatar agentId={item.session.agent?.userId} sessionId={item.session.conversationId} presentation={presentation} />}
              // owner 10-28:列表行不写机器;点开的卡片里照旧说是哪台(下面 SettlementCard 的 machine)。
              subtitle={agentName}
              meta={presentation && <span className="text-[var(--text-secondary)]">{agentStatusText(presentation.label)}</span>} />
          })}
        </div>
        {task && <PendingTask key={taskKey(task)} task={task} onOpenTask={() => { setOpened(false); followLink({ kind: 'session', sessionId: task.session.conversationId }) }} />}
      </div>
    </Sheet>}
  </>
})

function PendingTask({ task, onOpenTask }: { task: NeedsYouTask; onOpenTask: () => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const read = useTimelineSession(task.phoneHost ? phoneTimelineClient : assistantTimelineClient(task.local), mobile ? 'mobile' : 'desktop', task.deviceId, task.session.conversationId, true)
  const ready = read.phase === 'ready' && read.link === 'ok'
  const previousInstalls = useRef<string[]>([])
  const pending = useMemo(() => Object.values(read.timeline.settlements).filter(item => item.state === 'pending'), [read.timeline.settlements])
  // The host's timeout and answers on another device withdraw the same permission sheet here.
  useEffect(() => {
    const installs = ready ? pending.filter(item => appInstallAskOf(item.origin)).map(item => item.itemId) : []
    for (const id of previousInstalls.current) if (!installs.includes(id)) closeInShell(id)
    previousInstalls.current = installs
  }, [ready, pending])
  useEffect(() => () => { for (const id of previousInstalls.current) closeInShell(id) }, [])
  const source = (
    <Button variant="ghost" size="sm" role="link" data-testid="needs-you-source-link" onClick={onOpenTask}
      className="self-start max-w-full min-w-0 !gap-1 !px-0 !text-[length:var(--font-caption)] hover:!text-[var(--text-primary)] hover:underline">
      <span className="truncate">{t('needsYou.sourceTask', { title: task.session.title })}</span>
      <ArrowRight size={12} className="size-3 shrink-0" />
    </Button>
  )
  return <section data-testid="needs-you-pending" className="gg-aw !bg-transparent gap-3">
    {(!ready || pending.length === 0) && source}
    {(read.error || read.actionError) && <p role="alert">{read.error || read.actionError}</p>}
    {!ready && <p role="status">{t('needsYou.loading')}</p>}
    {ready && pending.map((settlement, index) => <SettlementCard key={settlement.itemId} settlement={settlement} runtime={task.session.runtime} source={index === 0 ? source : undefined}
      machine={task.local ? undefined : task.machine} busy={read.respondingItemId === settlement.itemId}
      onRespond={input => { void read.respond(input).catch(() => undefined) }} />)}
  </section>
}
