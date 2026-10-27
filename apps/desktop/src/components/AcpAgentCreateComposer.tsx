import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentViewerDialog, ChatComposer, MessageProvider, formatAttachmentSize, readAttachmentPreviewText, type ComposerAgentOption, type ComposerAttachment, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider as SessionUiThemeProvider } from '@gugu/session-ui/react/primitives'
import { Folder, Monitor } from '@/lib/icons'
import { useLocale } from '@/i18n'
import { useTheme } from '../store/theme'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useContactsStore } from '../store/contactsContext'
import { contactsService } from '../lib/contacts'
import { chatService } from '../lib/chat'
import { sendFileToChat } from '../lib/attachmentsEndpoint'
import { deviceFsListDirectory } from '../lib/deviceFs'
import { useAgentCreationTools } from '../hooks/useAgentCreationTools'
import { resolveAgentDefaultName } from '../lib/agentDefaultName'
import { openCreatedAgentConversation } from '../lib/agentCreationLifecycle'
import { rendererLogger } from '../lib/log'
import { completedSingleProvisionSession, provisionSingleAgent, resumeSingleAgent, type ProvisionResumeRecord, type SingleProvisionResult } from '../lib/agentProvision'
import type { AgentCreateContextController } from '../hooks/useAgentCreateContextBridge'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { SelectableAgentType } from '@gugu/core/shared/enums/agentTypeModels'
import { DropdownMenu } from './ui/Menu'
import { RemoteFolderPicker } from './RemoteFolderPicker'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'
import { useToast } from './toastContext'
import { openComposerImage } from '../lib/imageViewer'
import { platform } from '../platform'
import { rpc, rpcOn } from '../session/renderer/lib/ipc'
import { providerConsumesStartupPrompt } from '@gugu/session-core/agents/plugins'
import { pluginIdForAgentType } from '@gugu/core/agentTypes'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { guguCatalogReasonKind, type SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { createModelName, createModelOptions } from '../mobile/agent-watch/session-model-menu'
import { composerTierLabel } from '../session/renderer/features/sessions/session-config/use-composer-model-options'
import { allGuguHidden, defaultCreateModel, offeredInCreateMenu } from '../lib/createModelDefault'
import { openBillingPage } from '../lib/appLinks'
import { openShellSettings } from '../session/renderer/lib/open-shell-settings'
import { translateSessionMessage } from '../session/renderer/localization/locale-store'
import { guguReasonText } from '../session/renderer/features/sessions/gugu-reason'
import { cloudComputerFailureKind } from '@gugu/core/cloud/cloudComputer'
import { wakeCloudComputer } from '../lib/cloudComputerStore'
import type { CreateContextDevice } from '../lib/agentCreateContextBridge'
import './AcpAgentCreateComposer.css'

/**
 * 设备菜单里那一行的状态字:在线 / 离线;云电脑收回着 = 不说(选了、开始输入就连它)、正在起来 = 正在连接
 * (❌ 说离线;owner 10-17 ❌「休息中 / 正在醒来」)。
 */
function deviceStatusText(device: CreateContextDevice, t: (key: string) => string): string | null {
  if (device.cloudComputer === 'asleep') return null
  if (device.cloudComputer === 'waking') return t('create.devices.connecting')
  return device.isOnline ? t('create.devices.online') : t('create.devices.offline')
}

type CompletedSession = ReturnType<typeof completedSingleProvisionSession>

const createLog = rendererLogger('agent/create-composer')

type PendingFile = { id: string; file: File }
// @@@ pending delivery holds the agent, never the words - the composer's visible state
// (editor text + attachment chips) is the single custodian of what has NOT been delivered,
// so a retry sends what is on screen now instead of a snapshot frozen at creation time.
type PendingDelivery = {
  session: CompletedSession
  messageId: string
  messageIdPrompt: string
  startupPromptConsumed: boolean
}
type DeliveryProgress = { promptDelivered: boolean }

function projectLabel(path: string | null): string | null {
  if (!path) return null
  const normalized = path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).pop() || normalized
}

export function AcpAgentCreateComposer({ context, onCreated }: {
  context: AgentCreateContextController
  onCreated: (chatId: string) => void
}) {
  const { t } = useTranslation('agents')
  const { t: tc } = useTranslation('common')
  const { t: tMain } = useTranslation('main')
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const { user } = useAuth()
  const { contacts, refreshContacts } = useContactsStore()
  const { setActiveChatId, upsertChat } = useChatStore('setActiveChatId', 'upsertChat')
  const { toast } = useToast()
  const { tools: creationTools, error: creationToolsError } = useAgentCreationTools()
  const [provider, setProvider] = useState<SelectableAgentType | null>(null)
  const [prompt, setPrompt] = useState('')
  const editorApiRef = useRef<PromptEditorRef | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  // 点开一枚 chip 看里面是什么(#5269)。图片看图,文本看内容;两样都没有的类型 chip 本身不可点。
  const [attachmentViewer, setAttachmentViewer] = useState<ComposerAttachment | null>(null)
  const pendingFilesRef = useRef(new Map<string, File>())
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<ProvisionResumeRecord | null>(null)
  const [pendingDelivery, setPendingDelivery] = useState<PendingDelivery | null>(null)
  // 用哪个模型(#6264):目录问所选那台机器要(与手机「新建会话」同一个设备接口),选中的 id 跟着
  // agent.create 到那台机器上解释。null = 这家 agent 自己的默认模型。
  const [models, setModels] = useState<SessionpageSessionCreateModels | null>(null)
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [model, setModel] = useState<string | null>(null)
  const [modelTouched, setModelTouched] = useState(false)
  const { snapshot, rememberedProjectId } = context
  const selectedDevice = snapshot.devices.find((device) => device.id === snapshot.selectedDeviceId) ?? null
  // #7199 目标是一台睡着的云电脑:开始输入(打字 / 贴附件)才叫醒它 —— 光选它 ❌ 叫醒(看一眼不该扣积分);醒要 20 秒左右,
  // 打完字基本就醒了,项目、模型随之能选。叫醒没成就说原因,之后不每敲一个字再叫一次(建的时候还会再叫)。
  const selectedId = selectedDevice?.id ?? null
  const selectedAsleep = selectedDevice?.cloudComputer === 'asleep'
  const inputKey = `${attachments.length}:${prompt}`
  const lastInput = useRef<string | null>(null)
  const wakeFailedFor = useRef<string | null>(null)
  // 这里发出、还没落地的那一叫是给哪一台的:只有它在叫(或管家说它正在醒)时才说「正在连接」(❌ 光选着它就这么说)。
  const [wakingFor, setWakingFor] = useState<string | null>(null)
  useEffect(() => {
    const previous = lastInput.current
    lastInput.current = inputKey
    if (previous === null || previous === inputKey) return
    if (!selectedId || !selectedAsleep || wakeFailedFor.current === selectedId) return
    setWakingFor(selectedId)
    wakeCloudComputer().catch((err: unknown) => {
      wakeFailedFor.current = selectedId
      // 原因只说那一类(common 词条),原文进日志。
      createLog.warn({ err: String((err as Error)?.message ?? err) }, 'wake cloud computer failed')
      const kind = cloudComputerFailureKind(err)
      setError(kind === 'credits_exhausted'
        ? t('create.devices.creditsExhausted')
        : `${t('create.devices.wakeFailed')}${tc(`cloudComputer.reason.${kind}`)}`)
    }).finally(() => setWakingFor((current) => (current === selectedId ? null : current)))
  }, [inputKey, selectedId, selectedAsleep, t, tc])
  const selectedConnecting = selectedDevice?.cloudComputer === 'waking' || (selectedAsleep && wakingFor === selectedId)
  const selectedProjectPath = snapshot.selectedProjectId

  const translateComposerMessage = useCallback((key: string, values?: Readonly<Record<string, string | number>>) => {
    switch (key) {
      case 'composer.agent': return t('create.composer.provider')
      case 'composer.searchAgents': return t('create.composer.searchProviders')
      case 'composer.agentLocked': return t('create.composer.providerLocked', { name: values?.agentName ?? '' })
      case 'composer.sendMessage': return t('create.composer.send')
      // Wiring `onAttach` is what makes the shared composer render this button, so its label
      // must exist or the switch below takes the whole create surface down (#3522 regression).
      case 'composer.addAttachment': return t('create.composer.addAttachment')
      case 'composer.viewAttachment': return t('create.composer.viewAttachment', { name: values?.name ?? '' })
      case 'attachmentViewer.title': return t('create.composer.attachmentPreview')
      case 'attachmentViewer.truncated': return t('create.composer.attachmentPreviewTruncated')
      case 'attachmentViewer.unavailable': return t('create.composer.attachmentPreviewUnavailable')
      case 'composer.removeAttachment': return t('create.composer.removeAttachment', { name: values?.name ?? '' })
      default: throw new Error(`Missing ACP composer translation: ${resolvedLocale}:${key}`)
    }
  }, [resolvedLocale, t])

  useEffect(() => {
    if (provider || creationTools.length === 0) return
    setProvider(creationTools[0]!.engine)
  }, [creationTools, provider])

  const harness = provider && pluginIdForAgentType(provider)
  useEffect(() => {
    if (!selectedDevice?.isOnline || !harness) { setModels(null); setModelsState('idle'); return }
    let cancelled = false
    setModels(null)
    setModelsState('loading')
    rpcOn(selectedDevice.isLocal ? null : selectedDevice.id).sessionTimeline.sessionCreateModels({ harness })
      .then((next) => {
        if (cancelled) return
        if (!next.ok) throw new Error(`${next.error.code}: ${next.error.message}`)
        setModels(next.value)
        setModelsState('ready')
      })
      .catch(() => { if (!cancelled) setModelsState('failed') })
    return () => { cancelled = true }
  }, [harness, selectedDevice?.id, selectedDevice?.isOnline, selectedDevice?.isLocal])
  // 换了机器 / agent 就重新按那台机器的目录定默认;人自己点过就只在所选模型已不在目录里时才放手。
  useEffect(() => { setModelTouched(false) }, [harness, selectedDevice?.id])
  useEffect(() => {
    if (!models) return
    setModel((current) => {
      if (modelTouched && (current === null || models.models.some((m) => m.id === current))) return current
      return defaultCreateModel(models)
    })
  }, [models, modelTouched])

  const agentOptions = useMemo<ComposerAgentOption[]>(() => creationTools.map((tool) => ({
    id: tool.engine, name: tool.label, icon: <img src={tool.icon} alt="" width={14} height={14} />,
  })), [creationTools])

  // A remembered path is only a candidate. Re-probe it on the selected device before surfacing it;
  // stale/off-device paths never become a silent default.
  useEffect(() => {
    if (!selectedDevice?.isOnline || !rememberedProjectId || selectedProjectPath) return
    const controller = new AbortController()
    void deviceFsListDirectory(
      selectedDevice.id,
      { path: rememberedProjectId, show_hidden: false },
      { signal: controller.signal, timeoutMs: 20_000, retryOnTimeout: false },
    ).then((response) => {
      if (controller.signal.aborted || !response.result || (response.error && response.error.code !== 'too_many_entries')) return
      const resolved = response.result.path
      context.reportAvailableProjects([resolved])
      context.selectProject(resolved)
    }).catch((reason: unknown) => {
      if ((reason as Error)?.name !== 'AbortError') {
        createLog.warn({ reason: String(reason) }, 'remembered project probe failed')
      }
    })
    return () => controller.abort()
  }, [context, rememberedProjectId, selectedDevice, selectedProjectPath])

  const fetchLatestOwnedAgents = useCallback(async (): Promise<ContactUser[]> => {
    if (!user) return []
    const latest = await contactsService.getContacts(user.id)
    return latest.filter((contact) => contact.type === 'agent' && contact.owner_user_id === user.id)
  }, [user])

  const fetchSerialFloor = useCallback(async (label: string): Promise<number> => {
    if (!user) return 0
    return contactsService.getAgentNameSerialFloor(user.id, label)
  }, [user])

  const finishDelivery = useCallback(async (
    delivery: PendingDelivery,
    prompt: string,
    files: PendingFile[],
    progress: DeliveryProgress,
  ) => {
    if (!user) throw new Error(t('create.composer.signedOut'))
    // Attachments first, then the text. Each file leaves the composer only once it has
    // really landed, so whatever is still on screen is exactly what a retry has left to send.
    for (const pending of files) {
      const { file } = pending
      await sendFileToChat(file, { chatId: delivery.session.chatId, senderId: user.id, toUserIds: [delivery.session.agent.id] })
      pendingFilesRef.current.delete(pending.id)
      setAttachments((current) => current.filter((attachment) => attachment.id !== pending.id))
    }
    if (prompt) {
      await chatService.sendMessage(
        delivery.session.chatId,
        user.id,
        prompt,
        delivery.messageId,
        'text',
        { toUserIds: [delivery.session.agent.id] },
      )
      progress.promptDelivered = true
    }
    openCreatedAgentConversation(delivery.session, { upsertChat })
    setActiveChatId(delivery.session.chatId)
    await refreshContacts()
    setPendingDelivery(null)
    toast(t('create.composer.created', { name: delivery.session.agent.display_name }), 'success')
    onCreated(delivery.session.chatId)
  }, [onCreated, refreshContacts, setActiveChatId, t, toast, upsertChat, user])

  // @@@ undelivered text goes back on screen - the prompt editor clears itself the instant it
  // hands us the text, so from that moment this component is the only custodian of what the
  // user typed. Leaving the composer empty after a failed delivery would tell the user their
  // words were sent when nothing was.
  const restoreUndelivered = useCallback((undelivered: string) => {
    if (!undelivered) return
    const editor = editorApiRef.current
    const typedSince = editor?.getText().trim() ?? ''
    // Restoring writes a draft; it never sends. So when the user typed something new while
    // the delivery was in flight, keeping both is safe — nothing is lost and nothing goes
    // out until they press send again.
    const restored = typedSince && typedSince !== undelivered ? `${undelivered}\n${typedSince}` : undelivered
    editor?.setText(restored)
    setPrompt(restored)
  }, [])

  const enqueueRemoteFiles = useCallback(async (files: File[]) => {
    const next = await Promise.all(files.map(async (file) => {
      const id = crypto.randomUUID()
      pendingFilesRef.current.set(id, file)
      const image = file.type.startsWith('image/')
      // 文本类附件的内容在入列时读一份 —— chip 点开看的就是它(#5269)。
      const preview = image ? undefined : await readAttachmentPreviewText(file)
      return {
        id,
        name: file.name,
        kind: image ? 'image' as const : 'file' as const,
        mimeType: file.type,
        previewUrl: image ? URL.createObjectURL(file) : undefined,
        previewText: preview?.text,
        previewTruncated: preview?.truncated,
        meta: formatAttachmentSize(file.size),
      }
    }))
    setAttachments((current) => [...current, ...next])
  }, [])

  const handleFiles = useCallback((files: File[]) => {
    const remoteFiles: File[] = []
    for (const file of files) {
      const path = selectedDevice?.isLocal
        ? platform.getPathForFile?.(file).trim().replace(/\\/g, '/') ?? ''
        : ''
      if (!path) {
        remoteFiles.push(file)
        continue
      }
      const name = path.split('/').pop() ?? path
      editorApiRef.current?.insertMention({ id: path, label: path, name, kind: 'file' })
    }
    if (remoteFiles.length > 0) {
      // ❌ 不裸 `void promise`:抛出会变成没人看见的静默丢,屏幕上只表现为「文件掉进去了什么都没发生」。
      enqueueRemoteFiles(remoteFiles).catch(() => { /* 入列失败:chip 不出现,正文照常可发 */ })
    }
  }, [enqueueRemoteFiles, selectedDevice?.isLocal])

  const handleAttachmentsChange = useCallback((next: ComposerAttachment[]) => {
    const ids = new Set(next.map((attachment) => attachment.id))
    for (const id of pendingFilesRef.current.keys()) {
      if (!ids.has(id)) pendingFilesRef.current.delete(id)
    }
    setAttachments(next)
  }, [])

  const handlePickedFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) handleFiles(files)
  }, [handleFiles])

  const submit = useCallback(async (text: string) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const prompt = text.trim()
    const files = Array.from(pendingFilesRef.current, ([id, file]) => ({ id, file }))
    const progress: DeliveryProgress = { promptDelivered: false }
    try {
      if (pendingDelivery) {
        // Reuse the client message id while the text is unchanged, so retrying after an
        // ambiguous failure dedupes server-side. An edited text needs its own id, or that
        // same dedupe would silently swallow the edit.
        let retry = pendingDelivery
        if (retry.messageIdPrompt !== prompt) {
          retry = { ...retry, messageId: crypto.randomUUID(), messageIdPrompt: prompt, startupPromptConsumed: false }
          setPendingDelivery(retry)
        }
        await finishDelivery(retry, retry.startupPromptConsumed ? '' : prompt, files, progress)
        return
      }
      if (!user) throw new Error(t('create.composer.signedOut'))
      if (!selectedDevice?.isOnline) throw new Error(t('create.composer.deviceRequired'))
      if (!selectedProjectPath) throw new Error(t('create.composer.projectRequired'))
      if (!provider) throw new Error(creationToolsError ?? t('create.error.toolUnavailable', { tool: '' }))
      const tool = creationTools.find((candidate) => candidate.engine === provider)
      if (!tool) throw new Error(t('create.error.toolUnavailable', { tool: provider }))
      const ownedSnapshot = contacts.filter((contact) => contact.type === 'agent' && contact.owner_user_id === user.id)
      const displayName = await resolveAgentDefaultName(fetchLatestOwnedAgents, ownedSnapshot, fetchSerialFloor, tool.label)
      const messageId = crypto.randomUUID()
      const runtimeDeps: Parameters<typeof provisionSingleAgent>[2] = {
        onAttemptRecorded: setAttempt,
        onOperationAcknowledged: setAttempt,
        model,
      }
      let startupPromptConsumed = false
      if (prompt) {
        const metadataProvider = pluginIdForAgentType(provider)
        const metadata = await rpc.agents.get(metadataProvider) as AgentPayload | null
        startupPromptConsumed = providerConsumesStartupPrompt(metadata?.capabilities.prompt, 'acp')
        if (startupPromptConsumed && !attempt) runtimeDeps.initialMessage = { messageId, text: prompt }
      }
      let result: SingleProvisionResult
      if (attempt) {
        result = await resumeSingleAgent(attempt, runtimeDeps)
      } else {
        result = await provisionSingleAgent(selectedDevice.id, {
          memberKey: 'single',
          displayName,
          agentType: provider,
          projectPath: selectedProjectPath,
          inheritMemory: false,
          historyImportRequired: false,
          memorySources: [],
        }, runtimeDeps)
      }
      if (result.outcome.member.phase === 'awaiting_terminal') {
        throw new Error(t('create.error.stillStarting'))
      }
      if (result.outcome.member.phase === 'failed') {
        throw new Error(t('create.error.startFailed'))
      }
      const delivery = {
        session: completedSingleProvisionSession(result),
        messageId,
        messageIdPrompt: prompt,
        startupPromptConsumed,
      }
      setAttempt(null)
      setPendingDelivery(delivery)
      // Startup-capable providers consume the initial text from argv/stdin. Legacy providers keep
      // the existing post-provision delivery path (including the chat message row).
      await finishDelivery(delivery, startupPromptConsumed ? '' : prompt, files, progress)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      // Whatever did not land goes back into the composer before the error is shown, so the
      // user can see and retry their own words instead of watching them disappear.
      if (!progress.promptDelivered) restoreUndelivered(prompt)
      createLog.error({ err: message }, 'acp agent create failed')
      setError(messageForUser(reason))
      toast(t('create.toast.createFailed'), 'error', messageForUser(reason))
    } finally {
      setSubmitting(false)
    }
  }, [attempt, contacts, creationTools, creationToolsError, fetchLatestOwnedAgents, fetchSerialFloor, finishDelivery, model, pendingDelivery, provider, restoreUndelivered, selectedDevice, selectedProjectPath, submitting, t, toast, user])

  const canSubmit = Boolean(!submitting && (pendingDelivery || (
    snapshot.ready && !snapshot.blockMessage && provider && selectedDevice?.isOnline && selectedProjectPath && (prompt.trim() || attachments.length > 0)
  )))

  // 组头、倍率、选完收起的名字与桌面模型菜单同一份装配(session-model-menu)。
  const modelHarnessName = agentOptions.find((option) => option.id === provider)?.name ?? provider ?? ''
  const modelOptions = models ? createModelOptions(models, modelHarnessName) : {}
  // 这一档用不了、不进清单的咕咕模型(#7056):只在底部「升级解锁更多模型」那一条下面露一次面。
  const lockedModels = models ? models.models.filter((m) => m.source === 'gugu' && m.requires_membership).map((m) => m.name) : []

  const toolbarExtra = (
    <div className="acp-agent-create-toolbar">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="gg-ghost acp-agent-create-trigger" aria-label={t('create.composer.device')}
          disabled={submitting || Boolean(pendingDelivery)}>
          <Monitor size={13} />
          <span className="acp-agent-create-ellipsis">
            {selectedDevice?.label ?? t('create.composer.device')}
          </span>
          {selectedConnecting ? (
            <small className="acp-agent-create-device-status" data-testid="agent-create-device-waking">{t('create.devices.connecting')}</small>
          ) : null}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" style={{ minWidth: 220 }}>
          {snapshot.devices.map((device) => {
            const status = deviceStatusText(device, t)
            return <DropdownMenu.Item
              key={device.id}
              data-device-id={device.id}
              disabled={!device.isOnline && !device.cloudComputer}
              onClick={() => context.selectDevice(device.id)}
            >
              <span>{device.label}</span>
              {status !== null ? <small className="acp-agent-create-device-status">{status}</small> : null}
            </DropdownMenu.Item>
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <Button variant="ghost" size="sm" className="acp-agent-create-project" aria-label={t('create.composer.project')}
        disabled={!selectedDevice?.isOnline || submitting || Boolean(pendingDelivery)}
        onClick={() => setShowProjectPicker(true)}>
        <Folder size={13} />
        <span className="acp-agent-create-ellipsis">
          {projectLabel(selectedProjectPath) ?? t('create.composer.project')}
        </span>
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="gg-ghost acp-agent-create-trigger"
          data-testid="agent-create-model-picker" aria-label={tMain('agentWatch.create.model')}
          disabled={!selectedDevice?.isOnline || !provider || submitting || Boolean(attempt || pendingDelivery)}>
          <span className="acp-agent-create-ellipsis">
            {model
              ? (models ? createModelName(models, model) : null) ?? model
              : modelsState === 'loading' ? tMain('agentWatch.create.modelLoading') : tMain('agentWatch.create.modelDefault')}
          </span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" className="min-w-[260px] max-w-[360px] max-h-[360px] overflow-y-auto">
          <DropdownMenu.Item data-model-id="" onClick={() => { setModelTouched(true); setModel(null) }}>
            <span>{tMain('agentWatch.create.modelDefault')}</span>
            <small className="acp-agent-create-device-status">{tMain('agentWatch.create.modelDefaultHint')}</small>
          </DropdownMenu.Item>
          {modelsState === 'failed' ? (
            <div className="acp-agent-create-model-note">{tMain('agentWatch.create.modelFailed')}</div>
          ) : null}
          {models ? (['harness', 'gugu'] as const).map((source) => {
            // 只列点得中、跑得起来的:要会员的、他在设置里关掉的都不列(#7056,与桌面下拉同一个判据)。
            const rows = models.models.filter((m) => m.source === source && offeredInCreateMenu(m))
            // 组空时只写一句人话;机器报来的原话(常是一整段英文诊断)放进悬停提示,❌ 不把它铺进菜单。
            // 咕咕那组机器报的是原因码(`guguCatalogReasonKind`),❌ 把它或老版本的原文直接铺出来。
            const guguKind = guguCatalogReasonKind(models.guguReason)
            const reason = source === 'gugu'
              ? guguKind && guguReasonText(guguKind, translateSessionMessage)
              : tMain(`agentWatch.create.modelHarnessState.${models.harnessState}`)
            const reasonDetail = source === 'harness' ? models.harnessReason ?? undefined : undefined
            return (
              <div key={source} data-source={source}>
                <div className="acp-agent-create-model-group">
                  {composerTierLabel(source === 'gugu' ? 'platform' : 'own', modelHarnessName)}
                </div>
                {rows.length > 0 ? rows.map((m) => (
                  <DropdownMenu.Item key={m.id} data-model-id={m.id} data-source={m.source}
                    onClick={() => { setModelTouched(true); setModel(m.id) }}>
                    <span>{modelOptions[m.id]?.name ?? m.name}</span>
                    {modelOptions[m.id]?.description ? (
                      <small className="acp-agent-create-device-status">{modelOptions[m.id]?.description}</small>
                    ) : null}
                  </DropdownMenu.Item>
                )) : (
                  <div className="acp-agent-create-model-note" title={reasonDetail}>
                    {source === 'gugu' && allGuguHidden(models)
                      ? tMain('agentWatch.create.modelGuguAllHidden')
                      : (reason ?? tMain('agentWatch.create.modelNone'))}
                  </div>
                )}
              </div>
            )
          }) : null}
          {/* 底部去路(#7056),与桌面模型面板 / 手机清单同一组:管理模型 → 设置「模型」页;免费档再给升级解锁。 */}
          <DropdownMenu.Item data-testid="agent-create-model-manage" onClick={() => openShellSettings('model')}>
            <span>{translateSessionMessage('composer.manageModels')}</span>
          </DropdownMenu.Item>
          {lockedModels.length > 0 ? (
            <DropdownMenu.Item data-testid="agent-create-model-upgrade" onClick={openBillingPage}>
              <span>{translateSessionMessage('composer.platformModelUpgrade')}</span>
              <small className="acp-agent-create-device-status">
                {translateSessionMessage('composer.platformModelUpgradeList', { models: lockedModels.join(' · ') })}
              </small>
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  )

  return (
    <SessionUiThemeProvider theme={theme} target="documentElement">
      <MessageProvider locale={resolvedLocale} translate={translateComposerMessage}>
        <div className="acp-agent-create"
          data-testid="agent-create-draft" data-create-context-ready={snapshot.ready ? 'true' : 'false'}>
          <h1 className="acp-agent-create-title">{t('create.title')}</h1>
          <div className="acp-agent-create-composer">
            <input ref={fileInputRef} type="file" multiple hidden onChange={handlePickedFiles} />
            <ChatComposer agentOptions={agentOptions} selectedAgent={provider ?? undefined}
              onAgentChange={(id) => setProvider(id as SelectableAgentType)}
              agentLocked={Boolean(attempt || pendingDelivery)} canSubmit={canSubmit} showSubmitButton
              placeholder={t('create.composer.prompt')} onInputChange={setPrompt} onSubmit={submit}
              editorApiRef={editorApiRef} attachments={attachments} onAttachmentsChange={handleAttachmentsChange}
              onAttach={() => fileInputRef.current?.click()} onImageFilesDropped={handleFiles}
              onFilesDropped={handleFiles} onViewAttachment={(att) => { if (!openComposerImage(att)) setAttachmentViewer(att) }} toolbarExtra={toolbarExtra} />
            <AttachmentViewerDialog open={!!attachmentViewer}
              onOpenChange={(open) => { if (!open) setAttachmentViewer(null) }}
              name={attachmentViewer?.name}
              text={attachmentViewer?.previewText} truncated={attachmentViewer?.previewTruncated} />
            {(snapshot.blockMessage || error || creationToolsError) && <p role="alert" data-testid="create-agent-composer-error"
              className="acp-agent-create-error">{error ?? creationToolsError ?? snapshot.blockMessage}</p>}
          </div>
        </div>
        {showProjectPicker && selectedDevice && (
          <Sheet onClose={() => setShowProjectPicker(false)} ariaLabel={t('create.composer.project')}
            desktopWidth="min(640px, calc(100vw - 32px))"
            mobileHeight="80dvh" testId="agent-create-project-sheet">
            <div className="acp-agent-create-sheet-content">
              <RemoteFolderPicker deviceId={selectedDevice.id} initialPath={rememberedProjectId ?? '~'}
                onCancel={() => setShowProjectPicker(false)}
                onSelect={(path) => {
                  context.reportAvailableProjects([path])
                  context.selectProject(path)
                  setShowProjectPicker(false)
                }}
              />
            </div>
          </Sheet>
        )}
      </MessageProvider>
    </SessionUiThemeProvider>
  )
}
