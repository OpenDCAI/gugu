// #7350 关闭咕咕的确认框只有一个(product spec「关闭咕咕」):设置里的「关闭咕咕」、通讯录 / agent 设置里删它,
// 都只发 `requestAssistantClose()`,这里按它住哪画对应的那一份 —— ❌ 走通讯录那条「删除 Agent」的通用确认(它一个字不提记忆和家)。
//   - 住这台电脑上:清它的记忆、性格、文件、定时任务;它开过的会话删不删由人勾(默认留)。步骤见 lib/assistantClose。
//   - 住云上:同一份确认、同一套关闭步骤；管家只清助理资料，宿主和保留的会话不删除。
//   - 住别的电脑上:它的家和定时任务都在那台,这里关不干净 —— 照实说去那台关。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpcOn } from '@renderer/lib/ipc'
import { moveJournalStore } from '@renderer/features/assistant/assistant-move-wire'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { cn } from '../../lib/cn'
import { notify } from '../../lib/notices'
import { listDevicesOnceIdentified } from '../../lib/listDevicesOnceIdentified'
import { wakeCloudComputerUntilOnline } from '@gugu/core/cloud/cloudComputer'
import { rendererCloudComputerClient } from '../../lib/cloudComputer'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { reloadMyAssistant } from '../../lib/myAssistant'
import { assistantResumeStore } from '../../lib/assistantSetup'
import { retireCustomizeCard, writeSetupStep } from '../../lib/assistantSetupState'
import { ASSISTANT_HOME_CHANNELS } from '../../lib/assistantHomeIpc'
import {
  AssistantCloseError,
  closeLocalAssistant,
  planLocalClose,
  type LocalCloseDeps,
  type LocalClosePlan,
} from '../../lib/assistantClose'
import { UI_EVENTS } from '../../lib/uiEvents'
import { rendererLogger } from '../../lib/log'
import { desktopIpc } from '../../platform/desktopIpc'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import '../../i18n/registerAssistantCatalog'

const log = rendererLogger('assistant/close')
const text = 'text-[length:var(--font-body)] leading-[1.5]'

type Open = { assistantId: string; name: string } & (
  | { kind: 'local' }
  | { kind: 'cloud'; deviceId: string }
  | { kind: 'elsewhere'; device: string })

export function AssistantCloseHost() {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const ownerUserId = user?.id ?? null
  const { contact, home } = useAssistantHome()
  const { removeOwnedAgent } = useContactsStore()
  const { refresh } = useDevicesStore()
  const [open, setOpen] = useState<Open | null>(null)

  useEffect(() => {
    const onRequest = () => {
      if (!contact || !home) {
        log.warn({ hasContact: !!contact, hasHome: !!home }, 'close requested but the assistant or its home is not known')
        return
      }
      const who = { assistantId: contact.id, name: contact.display_name }
      if (home.kind === 'cloud') {
        setOpen({ ...who, kind: 'cloud', deviceId: home.deviceId })
        return
      }
      if (home.thisDevice) setOpen({ ...who, kind: 'local' })
      else setOpen({ ...who, kind: 'elsewhere', device: home.label ?? t('home.thatComputer') })
    }
    window.addEventListener(UI_EVENTS.closeAssistant, onRequest)
    return () => window.removeEventListener(UI_EVENTS.closeAssistant, onRequest)
  }, [contact, home, t])

  const localDeps = useMemo<LocalCloseDeps | null>(() => {
    if (!ownerUserId) return null
    const cloud = open?.kind === 'cloud' ? open : null
    const target = cloud?.deviceId ?? null
    const checkCloud = async () => {
      if (!cloud) return
      const client = rendererCloudComputerClient()
      if (!client) throw new Error('cloud computer is not configured')
      await client.prepareAssistantClose({ deviceId: cloud.deviceId, assistantId: cloud.assistantId })
    }
    return {
      check: checkCloud,
      listSessions: async () => {
        if (cloud) {
          const client = rendererCloudComputerClient()
          if (!client) throw new Error('cloud computer is not configured')
          const result = await wakeCloudComputerUntilOnline({ client, deviceId: cloud.deviceId, purpose: 'close', isOnline: async (id) => (await listDevicesOnceIdentified()).some((device) => device.device_id === id && device.is_online) })
          if (result !== 'online') throw new Error('the cloud home changed before close')
          await checkCloud()
        }
        return (await rpcOn(target).sessionTimeline.sessionsList()).sessions
      },
      listAutomations: () => rpcOn(target).automations.listAutomations(),
      deleteAutomation: (id) => rpcOn(target).automations.deleteAutomation(id),
      removeAgent: (agentUserId) => removeOwnedAgent(agentUserId),
      archiveSession: async (projectId, sessionId) => {
        const outcome = await rpcOn(target).sessions.archiveSession(projectId, sessionId, { withChildren: false })
        if (outcome.unreached.length > 0) throw new Error(`archive did not reach ${outcome.unreached.length} machine(s)`)
      },
      wipeHome: async () => {
        if (cloud) {
          const client = rendererCloudComputerClient()
          if (!client) throw new Error('cloud computer is not configured')
          await client.closeAssistant({ deviceId: cloud.deviceId, assistantId: cloud.assistantId })
          await refresh()
          return
        }
        const ipc = desktopIpc()
        if (!ipc) throw new Error('only the desktop app can clear its home')
        await ipc.invoke(ASSISTANT_HOME_CHANNELS.wipe)
      },
      resetLocalState: () => {
        writeSetupStep(ownerUserId, null)
        retireCustomizeCard(ownerUserId)
        for (const record of assistantResumeStore.list(ownerUserId)) assistantResumeStore.forget(ownerUserId, record.operationId)
        moveJournalStore(ownerUserId).clear()
        reloadMyAssistant(ownerUserId)
      },
    }
  }, [ownerUserId, removeOwnedAgent, open, refresh])

  const close = useCallback(() => setOpen(null), [])
  if (!open) return null
  const name = open.name

  if (open.kind === 'elsewhere') {
    return (
      <Sheet onClose={close} desktopWidth="400px" mobileFitContent ariaLabel={t('closeDialog.elsewhereTitle')} testId="assistant-close-elsewhere" zIndex="var(--z-settings-modal)">
        <div className="flex flex-col gap-3 p-[18px]">
          <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('closeDialog.elsewhereTitle')}</div>
          <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.elsewhereBody', { name, device: open.device })}</div>
          <div className="flex justify-end">
            <Button size="sm" onClick={close}>{t('closeDialog.elsewhereOk')}</Button>
          </div>
        </div>
      </Sheet>
    )
  }

  if (!localDeps) return null
  return <LocalCloseDialog assistantId={open.assistantId} name={name} deps={localDeps} onClose={close} />
}

function LocalCloseDialog({ assistantId, name, deps, onClose }: { assistantId: string; name: string; deps: LocalCloseDeps; onClose: () => void }) {
  const { t } = useTranslation('assistant')
  const [plan, setPlan] = useState<LocalClosePlan | 'loading' | 'unreadable'>('loading')
  const [deleteStarted, setDeleteStarted] = useState(false)
  const [closing, setClosing] = useState(false)
  const [failure, setFailure] = useState<AssistantCloseError | null>(null)

  useEffect(() => {
    let cancelled = false
    planLocalClose(assistantId, deps)
      .then((next) => !cancelled && setPlan(next))
      .catch((error: unknown) => {
        // 读不到它开过哪些会话 = 不知道那个勾在说什么、也不知道它自己的会话在哪:❌ 照着空清单关。
        log.warn({ error: String(error) }, 'list sessions for closing the assistant failed')
        if (!cancelled) setPlan('unreadable')
      })
    return () => {
      cancelled = true
    }
  }, [assistantId, deps])

  const confirm = async () => {
    if (typeof plan !== 'object') return
    setClosing(true)
    setFailure(null)
    try {
      await closeLocalAssistant({ assistantId, deleteStarted }, plan, deps)
      notify({ title: t('closeDialog.closed'), tier: 'success' })
      onClose()
    } catch (error) {
      const known = error instanceof AssistantCloseError ? error : new AssistantCloseError('home', 'failed', error)
      log.error({ step: known.step, kind: known.kind, error: String((known.reason as Error)?.message ?? known.reason) }, 'close local assistant failed')
      setFailure(known)
      setClosing(false)
    }
  }

  const started = typeof plan === 'object' ? plan.started : []
  return (
    <Sheet
      onClose={closing ? () => undefined : onClose}
      desktopWidth="400px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('closeDialog.title', { name })}
      testId="assistant-close-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('closeDialog.title', { name })}</div>
        <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.body')}</div>
        {plan === 'loading' && <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.checking')}</div>}
        {plan === 'unreadable' && <div className={cn(text, 'text-[var(--danger-fg)]')} role="alert">{t('closeDialog.unreadable')}</div>}
        {started.length > 0 && (
          <div className="flex flex-col gap-2">
            <label className={cn(text, 'flex cursor-pointer items-start gap-2 text-[var(--fg)]')}>
              <input
                type="checkbox"
                checked={deleteStarted}
                disabled={closing}
                onChange={(e) => setDeleteStarted(e.target.checked)}
                className="mt-[2px]"
                data-testid="assistant-close-delete-started"
              />
              <span>{t('closeDialog.deleteStarted', { count: started.length })}</span>
            </label>
            <div className="flex max-h-40 flex-col gap-[5px] overflow-y-auto rounded-[var(--radius-document)] bg-foreground/[0.025] px-[10px] py-2 dark:bg-foreground/[0.04]">
              {started.map((session) => (
                <div key={session.conversationId} className={cn(text, 'truncate text-[var(--fg)]')}>{session.title}</div>
              ))}
            </div>
            {!deleteStarted && <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.keepStartedNote')}</div>}
          </div>
        )}
        {failure && (
          <div className={cn(text, 'text-[var(--danger-fg)]')} role="alert" data-testid="assistant-close-failure">
            {failure.kind === 'schedule-starting' ? t('closeDialog.scheduleStarting') : t(`closeDialog.failedAt.${failure.step}`)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={closing}>{t('closeDialog.cancel')}</Button>
          <Button size="sm" variant="danger" disabled={closing || typeof plan !== 'object'} onClick={() => void confirm()} data-testid="assistant-close-confirm">
            {closing ? t('closeDialog.closing') : t('closeDialog.confirm')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
