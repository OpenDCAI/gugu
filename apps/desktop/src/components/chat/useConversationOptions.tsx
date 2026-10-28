import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import type { SessionOptionDimension } from '@gugu/session-core/session-record/contract'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { conversationOptionClient } from '../assistant/assistantTimelineClient'
import { sessionModelView } from '@/mobile/agent-watch/session-model-menu'
import { localizeEffortOptions } from '@renderer/features/sessions/session-config/effort-options'
import { localizePermissionModeOptions, selectedPermissionModeId } from '@renderer/features/sessions/acp/permission-mode-options'
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { messageForUser } from '@/lib/userFacingError'

export type ConversationTarget = { deviceId: string; sessionId: string; local: boolean; phoneHost?: boolean }

/** Adapts the host facts through the project page's model, effort and permission assemblers. */
export function useConversationOptions(target: ConversationTarget | null) {
  const deviceId = target?.deviceId, sessionId = target?.sessionId, local = target?.local, phoneHost = target?.phoneHost
  const key = target ? `${deviceId}/${sessionId}/${local}/${phoneHost}` : ''
  const [read, setRead] = useState<{ key: string; options: SessionpageSessionOptionsWithMenu } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [restart, setRestart] = useState<{ modelId: string; label: string; source: 'platform' | 'own' } | null>(null)
  const options = read?.key === key ? read.options : null
  useEffect(() => {
    if (!deviceId || !sessionId || local === undefined) return
    let live = true
    void conversationOptionClient({ deviceId, sessionId, local, phoneHost }).read().then(options => { if (live) setRead({ key, options }) }, cause => { if (live) setError(messageForUser(cause)) })
    return () => { live = false }
  }, [key, deviceId, sessionId, local, phoneHost])
  const pick = async (dimension: SessionOptionDimension, value: string) => {
    if (!target || options?.[dimension]?.selected === value) return
    setPending(true)
    try { setRead({ key, options: await conversationOptionClient(target).set(dimension, value) }); setError(null) }
    catch (cause) { setError(messageForUser(cause)) }
    finally { setPending(false) }
  }
  const model = options?.modelMenu && options.model ? sessionModelView(options.modelMenu, options.model) : null
  const permissions = options?.mode ? Object.fromEntries(options.mode.available.map(item => [item.id, { name: item.name, description: item.description }])) : null
  const props: Partial<ComponentProps<typeof AgentConversationComposer>> = {
    modelOptions: model ? Object.fromEntries(model.groups.flatMap(group => group.items.map(({ id, ...option }) => [id, option]))) : undefined,
    selectedModel: model?.selectedId,
    onModelChange: id => {
      const plan = model?.plan(id)
      if (plan?.kind === 'hot') void pick('model', plan.wireValue)
      else if (plan?.kind === 'reload') setRestart({ modelId: plan.modelId, label: plan.displayName, source: plan.source === 'platform' ? 'platform' : 'own' })
    },
    effortOptions: localizeEffortOptions(options?.effort ? Object.fromEntries(options.effort.available.map(item => [item.id, { name: item.name, description: item.description }])) : null, translateSessionMessage),
    selectedEffort: options?.effort?.selected ?? undefined,
    onEffortChange: id => { void pick('effort', id) },
    permissionModeOptions: localizePermissionModeOptions(permissions, translateSessionMessage, options?.modeMap),
    selectedPermissionMode: selectedPermissionModeId(options?.mode?.selected ?? undefined, permissions, options?.modeMap),
    onPermissionModeChange: id => { void pick('mode', id) },
    ...(error ? { notice: { variant: 'error', message: error, onDismiss: () => setError(null) } } : {}),
  }
  const confirmation = <SessionReloadConfirm open={!!restart} onOpenChange={open => { if (!open) setRestart(null) }}
    reason="model-switch" target={restart?.label ?? ''} isReloading={pending} onConfirm={async () => {
      if (!target || !restart) return
      setPending(true)
      try { setRead({ key, options: await conversationOptionClient(target).reload(restart) }); setRestart(null); setError(null) }
      catch (cause) { setError(messageForUser(cause)) }
      finally { setPending(false) }
    }} />
  return { props, confirmation, steers: options?.modelMenu?.steers === true }
}
