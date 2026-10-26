import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Markdown } from '../markdown/Markdown'
import { Monitor, Sparkles } from '../../lib/icons'
import { usePhoneRead, machineKey } from '../../mobile/assistant/usePhoneRead'
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import type { UserLibraryKind, UserLibraryEntry, UserLibraryRead } from '../../session/shared/user-library'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '../../session/renderer/features/assistant/assistant-ui-parts'
import { platform } from '../../platform'
import { libraryHost } from './assistant-library-client'
import { ShellSlot } from '../../session/renderer/features/assistant/assistant-shell'
import { AssistantDevicesPage } from '../devices/AssistantDevicesPage'
import { AssistantProjectsCard, AssistantProjectsLibrary } from './AssistantProjectsLibrary'
import { AssistantLibraryEditor } from './AssistantLibraryEditor'
import { assistantAppClient } from './assistant-app-client'
import { ASSISTANT_PANEL_APP } from '../../session/shared/extensions/assistant-app'
import { extensionProgramNotifiedChannel } from '../../session/shared/extensions/marketEvents'
import { onMachineEvent as onRuntimeMachineEvent } from '../../session/renderer/lib/ipc'
import { assistantPanelFailure } from './assistant-panel-errors'
import { onMachineEvent } from '../../mobile/agent-watch/sessionpage-rpc'
import { assistantPanelLibrary } from './assistant-panel-library'

function useLibraryNotifications(machine: LibraryProps['machine'], kind: UserLibraryKind, refresh: () => unknown) {
  useEffect(() => {
    if (machine?.panel || !machine) return
    const app = assistantAppClient(machine)
    const off = app.onProgramNotification(event => {
      if (event.method === 'notifications/resources/updated' && (event.params as { resource?: string })?.resource === kind) refresh()
    })
    const receive = ({ extensionId, ...notification }: NonNullable<typeof extensionProgramNotifiedChannel._data>) => {
      if (extensionId !== ASSISTANT_PANEL_APP.extensionId) return
      app.deliver({ type: 'programNotification', ...notification })
    }
    const stop = !platform.capabilities.agentRuntime && machine
      ? onMachineEvent(machine.deviceId, extensionProgramNotifiedChannel, receive)
      : onRuntimeMachineEvent(null, extensionProgramNotifiedChannel, receive)
    return () => { stop(); off() }
  }, [machine, kind, refresh])
}

type LibraryProps = { machine: AssistantMachine | null | undefined; assistantId: string; kind: UserLibraryKind | 'workspace'; askInChat: (text: string) => void }
const sourceKey = (machine: LibraryProps['machine'], kind: UserLibraryKind, assistantId: string) => machine ? `gugu-library|${assistantId}|${machineKey(machine)}|${kind}` : null
async function readVolume(machine: LibraryProps['machine'], kind: UserLibraryKind): Promise<UserLibraryRead> {
  if (machine?.panel) return assistantPanelLibrary(machine.panel).volume(kind)
  const result = await libraryHost(machine)!.getUserLibraryVolume(kind)
  if (!Array.isArray(result.items) || !result.volume) throw new Error('Gugu library host requires an update')
  return result
}

type CardProps = Omit<LibraryProps, 'askInChat'> & { onOpen: () => void }
export function AssistantLibraryCard(props: CardProps) {
  return props.kind === 'workspace' ? <AssistantProjectsCard machine={props.machine} onOpen={props.onOpen} /> : <FileLibraryCard {...props} kind={props.kind} />
}
function FileLibraryCard({ machine, assistantId, kind, onOpen }: Omit<CardProps, 'kind'> & { kind: UserLibraryKind }) {
  const { t } = useTranslation('assistant')
  const read = usePhoneRead(sourceKey(machine, kind, assistantId), () => readVolume(machine, kind), 'read Gugu library')
  useLibraryNotifications(machine, kind, read.refresh)
  const detail = kind === 'devices' ? t('library.deviceAccess') : read.state === 'loading' ? t('library.loading')
    : read.state === 'error' ? t('library.failed') : read.data.items.length ? t('library.items', { count: read.data.items.length }) : undefined
  return <AssistantRow leading={kind === 'devices' ? <Monitor /> : <Sparkles />} title={t(`library.${kind}`)} detail={detail}
    onClick={onOpen} testId={`assistant-library-${kind}`} />
}

export function AssistantLibraryVolume(props: LibraryProps) {
  return props.kind === 'workspace' ? <AssistantProjectsLibrary machine={props.machine} askInChat={props.askInChat} /> : <FileLibraryVolume key={props.assistantId} {...props} kind={props.kind} />
}
function FileLibraryVolume({ machine, assistantId, kind, askInChat }: Omit<LibraryProps, 'kind'> & { kind: UserLibraryKind }) {
  const { t } = useTranslation('assistant')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<UserLibraryEntry | 'new' | null>(null)
  const read = usePhoneRead(sourceKey(machine, kind, assistantId), () => readVolume(machine, kind), 'read Gugu library')
  const entry = usePhoneRead(machine && selected ? `${sourceKey(machine, kind, assistantId)}|${selected}` : null,
    () => machine?.panel ? assistantPanelLibrary(machine.panel).entry(kind,selected!) : libraryHost(machine)!.readUserLibraryEntry(kind, selected!), 'read Gugu library entry')
  useLibraryNotifications(machine, kind, read.refresh)
  useLibraryNotifications(machine, kind, entry.refresh)
  const title = t(`library.${kind}`)
  const opened = selected && entry.state === 'ok' ? entry.data : null
  const failed = read.state === 'error' || (selected && entry.state === 'error')
  const loading = read.state === 'loading' || (selected && entry.state === 'loading')
  const current = read.state === 'ok' ? read.data : null
  const groups = new Map<string, UserLibraryRead['items']>()
  for (const item of current?.items ?? []) {
    const group = item.group ?? t('library.ungrouped')
    const items = groups.get(group) ?? []; items.push(item); groups.set(group, items)
  }
  if (editing) return <AssistantLibraryEditor machine={machine} assistantId={assistantId} kind={kind} entry={editing === 'new' ? null : editing}
    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSelected(null); read.reload() }} />
  return <div className="ta-page" data-testid={`assistant-library-page-${kind}`}>
    <PageHead title={title} action={machine && <Button variant="ghost" className="ta-pill-btn" disabled={read.state !== 'ok'} onClick={() => setEditing(opened || 'new')}>{t(opened ? 'library.edit' : 'library.add')}</Button>} />
    {selected && <Button variant="ghost" className="ta-pill-btn self-start" onClick={() => setSelected(null)}>{t('library.backToIndex')}</Button>}
    {!selected && kind === 'devices' && (platform.capabilities.agentRuntime ? <ShellSlot name="devices" className="ta-skin" /> : <AssistantDevicesPage cloudDeviceId={null} />)}
    {!selected && <AssistantRow title={t('library.organize')} onClick={() => askInChat(t('library.setupPrompt', { kind: title }))} />}
    {failed ? <AssistantEmpty><span role="alert">{assistantPanelFailure(selected && entry.state === 'error' ? entry.error : read.state === 'error' ? read.error : null,t)}</span></AssistantEmpty>
      : loading ? <AssistantEmpty>{t('library.loading')}</AssistantEmpty>
      : opened ? <><p className="ta-page-sub">{opened.description}</p><div className="ta-card ta-prose" data-testid="assistant-library-content"><Markdown trust="chat" content={opened.content || t('library.emptyContent')} /></div></>
      : current?.items.length ? [...groups].map(([group, items]) => <AssistantSection key={group} title={group}>
          {items.map(item => <AssistantRow key={item.id} leading={kind === 'devices' ? <Monitor /> : <Sparkles />} title={item.name}
            detail={item.description || t('library.hasIndex')} onClick={() => setSelected(item.id)} testId={`assistant-library-item-${item.id}`} />)}
        </AssistantSection>) : <AssistantEmpty>{t('library.emptyIndex')}</AssistantEmpty>}
  </div>
}
