import { AssistantMemoryContent } from '@/components/assistant/AssistantMemoryContent'
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import './phone-memory.css'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '@/components/markdown/Markdown'
import { Button } from '@/components/ui/Button'
import { Sparkles, SquarePen, Trash2 } from '@/lib/icons'
import { isOwnerProfileNote, type MemoryKind } from '@/session/renderer/features/assistant/assistant-files'
import { readMemoryNotes, type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, AssistantRow, AssistantSection, ownerLeading, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { useAuth } from '@/store/auth'
import { memoryContentPreview } from '@/session/renderer/features/assistant/memory-content-preview'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneFiles } from './PhoneFiles'
import { PhoneHealth } from './PhoneHealth'
import { PhoneMachineView, ReadView, type OpenedPageProps } from './PhoneMachineView'
import { PhoneVoiceNotes } from './PhoneVoiceNotes'
import { deleteMemoryNote, filesTrail } from './phoneMemoryData'
import { machineKey, usePhoneRead, type PhoneRead } from './usePhoneRead'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

type Translate = (key: string, options?: Record<string, unknown>) => string
type NotesRead = PhoneRead<{ notes: MemoryEntry[]; index: string | null }> & { reload: () => void }

function kindLabel(kind: MemoryKind, t: Translate, name: string): string {
  if (kind === 'user') return t('memory.filter.user')
  if (kind === 'feedback') return t('memory.filter.assistant', { name })
  if (kind === 'project') return t('memory.kind.project')
  if (kind === 'reference') return t('memory.kind.reference')
  return t('memory.filter.other')
}

function useTime() {
  const { i18n } = useTranslation('assistant')
  return (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : ''
}

/**
 * 记忆首页只显示长期了解与约定；项目入口在资料页，记忆详情沿用原来的读写与导航。
 */
export function PhoneMemory(props: PhonePageProps) {
  const { sub, machine } = props
  const ready = machine.state === 'ready' ? machine.machine : null
  // 记忆那一夹各页共用一份读数(首页、一条的全文、健康页里它记的 health_* 几条)。
  const notes = usePhoneRead(ready ? `memory|${machineKey(ready)}` : null, () => readMemoryNotes(ready!), 'read memory')
  if (sub === 'health') return <PhoneHealth {...props} healthNotes={notes} />
  if (sub === 'voice' || sub?.startsWith('voice:')) return <PhoneVoiceNotes {...props} />
  if (sub === 'files' || sub?.startsWith('files:')) return <PhoneFiles key={sub} {...props} trail={filesTrail(sub)} />
  if (sub?.startsWith('note:')) return <MemoryNote {...props} file={sub.slice('note:'.length)} notes={notes} />
  return <MemoryHome {...props} notes={notes} />
}

function MemoryHome(props: PhonePageProps & { notes: NotesRead }) {
  const { t } = useTranslation('assistant')
  const { assistant, machine, notes } = props
  const name = assistant.display_name
  return (
    <div className="ta-page" data-testid="assistant-memory">
      <PhoneMachineView machine={machine} name={name}>
        {() => (
          <ReadView read={notes} failedTitle={t('memory.loadFailed')}>
            {(read) => <LongTermMemory {...props} notes={read.notes} />}
          </ReadView>
        )}
      </PhoneMachineView>
    </div>
  )
}

/** 关于你与其余长期记忆共用一组，点条目打开全文；未记下关于你时仍保留补充入口。 */
function LongTermMemory({ assistant, askInChat, go, notes, machine }: PhonePageProps & { notes: MemoryEntry[] }) {
  const { t } = useTranslation('assistant')
  const time = useTime()
  const { user } = useAuth()
  const owner = user ? { id: user.id, name: user.nickname, avatarUrl: user.avatarUrl ?? null } : null
  const aboutYou = notes.filter((entry) => entry.kind === 'user')
  return (
    <AssistantSection title={t('library.longTerm')} testId="assistant-memory-about">
      {aboutYou.length === 0 ? (
        <div className="ta-phone-empty-body">
          <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('memory.fasterPrompt'))} data-testid="assistant-memory-ask">
            <Sparkles />
            {t('memory.faster')}
          </Button>
        </div>
      ) : (
        aboutYou.map(row => <AssistantMemoryContent key={row.file} machine={machine.state === 'ready' ? machine.machine : undefined} entry={row}>{(entry,error) => <AssistantRow leading={owner?.avatarUrl ? ownerLeading(owner) : undefined} title={isOwnerProfileNote(entry) ? t('memory.filter.user') : entry.title} detailLines={4}
          detail={error ? assistantPanelFailure(error,t) : memoryContentPreview(entry.body) || (entry.modifiedAt ? t('memory.updated', { time: time(entry.modifiedAt) }) : undefined)} onClick={() => go(`note:${entry.file}`)} />}</AssistantMemoryContent>)
      )}
      {notes.some(entry => entry.kind !== 'user') ? <div data-testid="assistant-memory-all">
        <MemoryList assistant={assistant} go={go} machine={machine} notes={notes} />
      </div> : null}
    </AssistantSection>
  )
}

/** 其余记忆也属于长期了解与约定，正文预览和详情入口保持不变。 */
function MemoryList({ assistant, go, notes, machine }: Pick<PhonePageProps, 'assistant' | 'go' | 'machine'> & { notes: MemoryEntry[] }) {
  const { t } = useTranslation('assistant')
  const time = useTime()
  const name = assistant.display_name
  return (
    <div className="ta-phone-memory-list">
      {notes
        .filter((entry) => entry.kind !== 'user')
        .map((row) => (
          <AssistantMemoryContent key={row.file} machine={machine.state === 'ready' ? machine.machine : undefined} entry={row}>{(entry,error) => (
          <AssistantRow
            key={entry.file}
            title={entry.title}
            detail={error ? assistantPanelFailure(error,t) : memoryContentPreview(entry.body, 140) || (entry.modifiedAt ? t('memory.updated', { time: time(entry.modifiedAt) }) : kindLabel(entry.kind, t, name))}
            detailLines={4}
            onClick={() => go(`note:${entry.file}`)}
            testId={`assistant-memory-${entry.file}`}
          />)}</AssistantMemoryContent>
        ))}
    </div>
  )
}

/** 一条记忆的全文:正文、在对话中改(只填不发)、删(先确认;连同 MEMORY.md 里指向它的那一行),删完回首页重读。 */
function MemoryNote(props: PhonePageProps & { file: string; notes: NotesRead }) {
  const { t } = useTranslation('assistant')
  const { assistant, machine, notes, file } = props
  const opened = machine.state === 'ready' ? machine.machine : null
  const note = notes.state === 'ok' ? notes.data.notes.find((entry) => entry.file === file) ?? null : null
  if (opened && note) return <MemoryNoteBody {...props} machine={opened} note={note} />
  // 读到之前 / 读不到 / 已经不在了:页头先说是记忆,下面说清是哪一步。
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={t('nav.memory')} />
      <PhoneMachineView machine={machine} name={assistant.display_name}>
        {() => (
          <ReadView read={notes} failedTitle={t('memory.loadFailed')}>
            {() => <AssistantEmpty title={t('memory.goneTitle')}>{t('memory.gone')}</AssistantEmpty>}
          </ReadView>
        )}
      </PhoneMachineView>
    </div>
  )
}

function MemoryNoteBody({ assistant, askInChat, go, notes, machine, note }: OpenedPageProps & { notes: NotesRead; note: MemoryEntry }) {
  const { t } = useTranslation('assistant')
  const time = useTime()
  const [confirming, setConfirming] = useState(false)
  const name = assistant.display_name
  const aboutMe = isOwnerProfileNote(note)
  const title = aboutMe ? t('memory.filter.user') : note.title
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={title} sub={[aboutMe ? null : kindLabel(note.kind, t, name), note.modifiedAt ? t('memory.updated', { time: time(note.modifiedAt) }) : null].filter(Boolean).join(' · ')} />
      <div className="ta-card ta-prose" data-testid="assistant-memory-body">
        <AssistantMemoryContent machine={machine} entry={note}>{(current,error,loading) => error ? <span role="alert">{assistantPanelFailure(error,t)}</span> : loading ? <LoadingIndicator size="inline" /> : <Markdown trust="chat" content={current.body || t('memory.noContent')} />}</AssistantMemoryContent>
      </div>
      <p className="ta-page-sub ta-pad">{t('memory.createdBy', { name })}</p>
      <div className="ta-phone-row-actions">
        <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(aboutMe ? t('memory.editAboutMePrompt') : t('memory.editPrompt', { name: note.title }))} data-testid="assistant-memory-edit">
          <SquarePen />
          {t('memory.editInChat')}
        </Button>
        <Button variant="ghost" className="ta-pill-btn" data-tone="danger" onClick={() => setConfirming(true)} data-testid="assistant-memory-delete">
          <Trash2 />
          {t('common.delete')}
        </Button>
      </div>
      <PhoneConfirmDialog
          open={confirming}
          title={t('memory.deleteTitle')}
          body={t('memory.deleteBody', { name: title })}
          confirmLabel={t('common.delete')}
          failedText={t('memory.deleteFailed')}
          testId="assistant-memory-delete-dialog"
          onClose={() => setConfirming(false)}
          onConfirmed={() => { notes.reload(); go(null) }}
          onConfirm={async () => {
            await deleteMemoryNote(machine, note, () => reportAssistantAppChange(machine, assistant.id, { resource: 'memory', operation: 'removed',
              id: note.path, deviceId: machine.deviceId, before: { name: note.title, path: note.path } }))
          }}
        />

    </div>
  )
}
