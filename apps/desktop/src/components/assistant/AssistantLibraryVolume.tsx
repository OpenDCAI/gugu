import { useState } from 'react'
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

type LibraryProps = { machine: AssistantMachine | null | undefined; kind: UserLibraryKind | 'workspace'; askInChat: (text: string) => void }
const sourceKey = (machine: LibraryProps['machine'], kind: UserLibraryKind) => platform.capabilities.agentRuntime
  ? `gugu-library|here|${kind}` : machine ? `gugu-library|${machineKey(machine)}|${kind}` : null
async function readVolume(machine: LibraryProps['machine'], kind: UserLibraryKind): Promise<UserLibraryRead> {
  const result = await libraryHost(machine)!.getUserLibraryVolume(kind)
  if (!Array.isArray(result.items) || !result.volume) throw new Error('Gugu library host requires an update')
  return result
}

type CardProps = Omit<LibraryProps, 'askInChat'> & { onOpen: () => void }
export function AssistantLibraryCard(props: CardProps) {
  return props.kind === 'workspace' ? <AssistantProjectsCard machine={props.machine} onOpen={props.onOpen} /> : <FileLibraryCard {...props} kind={props.kind} />
}
function FileLibraryCard({ machine, kind, onOpen }: Omit<CardProps, 'kind'> & { kind: UserLibraryKind }) {
  const { t } = useTranslation('assistant')
  const read = usePhoneRead(sourceKey(machine, kind), () => readVolume(machine, kind), 'read Gugu library')
  const detail = kind === 'devices' ? t('library.deviceAccess') : read.state === 'loading' ? t('library.loading')
    : read.state === 'error' ? t('library.failed') : t('library.items', { count: read.data.items.length })
  return <AssistantRow leading={kind === 'devices' ? <Monitor /> : <Sparkles />} title={t(`library.${kind}`)} detail={detail}
    onClick={onOpen} testId={`assistant-library-${kind}`} />
}

export function AssistantLibraryVolume(props: LibraryProps) {
  return props.kind === 'workspace' ? <AssistantProjectsLibrary machine={props.machine} askInChat={props.askInChat} /> : <FileLibraryVolume {...props} kind={props.kind} />
}
function FileLibraryVolume({ machine, kind, askInChat }: Omit<LibraryProps, 'kind'> & { kind: UserLibraryKind }) {
  const { t } = useTranslation('assistant')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<UserLibraryEntry | 'new' | null>(null)
  const read = usePhoneRead(sourceKey(machine, kind), () => readVolume(machine, kind), 'read Gugu library')
  const entry = usePhoneRead(libraryHost(machine) && selected ? `${sourceKey(machine, kind)}|${selected}` : null,
    () => libraryHost(machine)!.readUserLibraryEntry(kind, selected!), 'read Gugu library entry')
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
  if (editing) return <AssistantLibraryEditor machine={machine} kind={kind} entry={editing === 'new' ? null : editing}
    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSelected(null); read.reload() }} />
  return <div className="ta-page" data-testid={`assistant-library-page-${kind}`}>
    <PageHead title={title} action={libraryHost(machine) && <Button variant="ghost" className="ta-pill-btn" onClick={() => setEditing(opened || 'new')}>{t(opened ? 'library.edit' : 'library.add')}</Button>} />
    {selected && <Button variant="ghost" className="ta-pill-btn self-start" onClick={() => setSelected(null)}>{t('library.backToIndex')}</Button>}
    {!selected && kind === 'devices' && (platform.capabilities.agentRuntime ? <ShellSlot name="devices" className="ta-skin" /> : <AssistantDevicesPage cloudDeviceId={null} assistantName="" />)}
    {!selected && <AssistantRow title={t('library.organize')} onClick={() => askInChat(t('library.setupPrompt', { kind: title }))} />}
    {failed ? <AssistantEmpty action={<Button onClick={selected ? entry.reload : read.reload}>{t('machine.retry')}</Button>}>{t('library.failed')}</AssistantEmpty>
      : loading ? <AssistantEmpty>{t('library.loading')}</AssistantEmpty>
      : opened ? <><p className="ta-page-sub">{opened.description}</p><div className="ta-card ta-prose" data-testid="assistant-library-content"><Markdown trust="chat" content={opened.content || t('library.emptyContent')} /></div></>
      : current?.items.length ? [...groups].map(([group, items]) => <AssistantSection key={group} title={group}>
          {items.map(item => <AssistantRow key={item.id} leading={kind === 'devices' ? <Monitor /> : <Sparkles />} title={item.name}
            detail={item.description || t('library.hasIndex')} onClick={() => setSelected(item.id)} testId={`assistant-library-item-${item.id}`} />)}
        </AssistantSection>) : <AssistantEmpty>{t('library.emptyIndex')}</AssistantEmpty>}
  </div>
}
