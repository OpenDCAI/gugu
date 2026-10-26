import './phone-memory.css'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '@/components/markdown/Markdown'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { Folder, Heart, Mic, Sparkles, SquarePen, Trash2 } from '@/lib/icons'
import { RESOURCES_DIR_NAME, type MemoryKind } from '@/session/renderer/features/assistant/assistant-files'
import { readMemoryNotes, type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, AssistantRow, AssistantSection, ownerLeading, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { useAuth } from '@/store/auth'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneFiles } from './PhoneFiles'
import { PhoneHealth } from './PhoneHealth'
import { PhoneMachineView, ReadView, type OpenedPageProps } from './PhoneMachineView'
import { PhoneLibraryVolume } from './PhoneLibraryVolume'
import { PhoneVoiceNotes } from './PhoneVoiceNotes'
import { deleteMemoryNote, filesTrail, readMemoryCounts } from './phoneMemoryData'
import { machineKey, usePhoneRead, type PhoneRead } from './usePhoneRead'
import { AssistantLibraryCard } from '@/components/assistant/AssistantLibraryVolume'
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
 * 「记忆」那一格(同桌面记忆页):「我对你的了解」那张卡 →「全部」两列小卡(健康、语音笔记、给助理的资料、其余每一条记忆)。
 * 往下钻(名字与桌面同一套):`note:<文件>` 一条记忆(全文、在对话中改、删)、`voice[:<id>]`、`files[:<路径>]`、`health`。
 * 记忆、语音笔记、资料都在它家里,醒着才读得到(❌ 自己叫醒);健康是这台手机自己的数据,它在休息也照样能点进去看。
 */
export function PhoneMemory(props: PhonePageProps) {
  const { sub, readiness, machine } = props
  const ready = readiness === 'ready' && machine.state === 'ready' ? machine.machine : null
  // 记忆那一夹各页共用一份读数(首页、一条的全文、健康页里它记的 health_* 几条)。
  const notes = usePhoneRead(ready ? `memory|${machineKey(ready)}` : null, () => readMemoryNotes(ready!), 'read memory')
  if (sub === 'library:workspace') return <PhoneLibraryVolume key={sub} {...props} kind="workspace" />
  if (sub === 'health') return <PhoneHealth {...props} healthNotes={notes} />
  if (sub === 'voice' || sub?.startsWith('voice:')) return <PhoneVoiceNotes {...props} />
  if (sub === 'files' || sub?.startsWith('files:')) return <PhoneFiles key={sub} {...props} trail={filesTrail(sub)} />
  if (sub?.startsWith('note:')) return <MemoryNote {...props} file={sub.slice('note:'.length)} notes={notes} />
  return <MemoryHome {...props} notes={notes} />
}

function MemoryHome(props: PhonePageProps & { notes: NotesRead }) {
  const { t } = useTranslation('assistant')
  const { assistant, readiness, machine, go, notes } = props
  const name = assistant.display_name
  return (
    <div className="ta-page" data-testid="assistant-memory">
      <PhoneMachineView readiness={readiness} machine={machine} name={name}>
        {() => (
          <ReadView read={notes} failedTitle={t('memory.loadFailed')}>
            {(read) => <AboutYou {...props} notes={read.notes} />}
          </ReadView>
        )}
      </PhoneMachineView>
      <AssistantSection title={t('library.workspace')}>
        <AssistantLibraryCard assistantId={assistant.id} machine={machine.state === 'ready' ? machine.machine : null} kind="workspace" onOpen={() => go('library:workspace')} />
      </AssistantSection>
      {notes.state === 'ok' && readiness === 'ready' && notes.data.notes.some((entry) => entry.kind !== 'user') ? (
        <AssistantSection title={t('library.memory')} bare testId="assistant-memory-all">
          <MemoryList {...props} notes={notes.data.notes} />
        </AssistantSection>
      ) : null}
      <MemorySources {...props} />
    </div>
  )
}

/** 「我对你的了解」:它记下的关于你的那几条(点一条看全文);一条没有时给「更快设置记忆」(只往聊天里填一句)。 */
function AboutYou({ askInChat, go, notes }: PhonePageProps & { notes: MemoryEntry[] }) {
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
        aboutYou.map(entry => <AssistantRow key={entry.file} leading={ownerLeading(owner)} title={entry.title}
          detail={entry.description || (entry.modifiedAt ? t('memory.updated', { time: time(entry.modifiedAt) }) : undefined)} onClick={() => go(`note:${entry.file}`)} />)
      )}
    </AssistantSection>
  )
}

/** 其余记忆按条目显示；独立来源入口不依赖这一组是否读到。 */
function MemoryList({ assistant, go, notes }: PhonePageProps & { notes: MemoryEntry[] }) {
  const { t } = useTranslation('assistant')
  const time = useTime()
  const name = assistant.display_name
  return (
    <div className="ta-phone-memory-list">
      {notes
        .filter((entry) => entry.kind !== 'user')
        .map((entry) => (
          <AssistantRow
            key={entry.file}
            title={entry.title}
            detail={entry.modifiedAt ? t('memory.updated', { time: time(entry.modifiedAt) }) : kindLabel(entry.kind, t, name)}
            onClick={() => go(`note:${entry.file}`)}
            testId={`assistant-memory-${entry.file}`}
          />
        ))}
    </div>
  )
}

/** 本机健康不依赖助理连接；远端来源可以先打开，由各自页面说明实际连接状态。 */
function MemorySources({ readiness, machine, go }: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const ready = readiness === 'ready' && machine.state === 'ready' ? machine.machine : null
  const counts = usePhoneRead(ready ? `memory-counts|${machineKey(ready)}` : null, () => readMemoryCounts(ready!), 'count memory folders')
  const voice = counts.state === 'ok' ? counts.data.voice : null
  const files = counts.state === 'ok' ? counts.data.files : null
  return (
    <AssistantSection title={t('library.sources')}>
      <AssistantRow leading={<Heart />} title={t('health.title')} onClick={() => go('health')} testId="assistant-memory-health" />
      <AssistantRow leading={<Mic />} title={t('memory.voiceNotes')} detail={voice === null ? t('memory.voiceNotesCount') : t('memory.items', { n: voice })} onClick={() => go('voice')} testId="assistant-memory-voice" />
      <AssistantRow leading={<Folder />} title={RESOURCES_DIR_NAME} detail={files === null ? undefined : t('memory.items', { n: files })} onClick={() => go('files')} testId="assistant-memory-files" />
    </AssistantSection>
  )
}

/** 一条记忆的全文:正文、在对话中改(只填不发)、删(先确认;连同 MEMORY.md 里指向它的那一行),删完回首页重读。 */
function MemoryNote(props: PhonePageProps & { file: string; notes: NotesRead }) {
  const { t } = useTranslation('assistant')
  const { assistant, readiness, machine, notes, file } = props
  const opened = readiness === 'ready' && machine.state === 'ready' ? machine.machine : null
  const note = notes.state === 'ok' ? notes.data.notes.find((entry) => entry.file === file) ?? null : null
  if (opened && note) return <MemoryNoteBody {...props} machine={opened} note={note} />
  // 读到之前 / 读不到 / 已经不在了:页头先说是记忆,下面说清是哪一步。
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={t('nav.memory')} />
      <PhoneMachineView readiness={readiness} machine={machine} name={assistant.display_name}>
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
  const { toast } = useToast()
  const time = useTime()
  const [confirming, setConfirming] = useState(false)
  const name = assistant.display_name
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={note.title} sub={[kindLabel(note.kind, t, name), note.modifiedAt ? t('memory.updated', { time: time(note.modifiedAt) }) : null].filter(Boolean).join(' · ')} />
      <div className="ta-card ta-prose" data-testid="assistant-memory-body">
        <Markdown trust="chat" content={note.body || t('memory.noContent')} />
      </div>
      <p className="ta-page-sub ta-pad">{t('memory.createdBy', { name })}</p>
      <div className="ta-phone-row-actions">
        <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('memory.editPrompt', { name: note.title }))} data-testid="assistant-memory-edit">
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
          body={t('memory.deleteBody', { name: note.title })}
          confirmLabel={t('common.delete')}
          failedText={t('memory.deleteFailed')}
          testId="assistant-memory-delete-dialog"
          onClose={() => setConfirming(false)}
          onConfirmed={() => { notes.reload(); go(null) }}
          onConfirm={async () => {
            await deleteMemoryNote(machine, note, () => reportAssistantAppChange(machine, assistant.id, { resource: 'memory', operation: 'removed',
              id: note.path, deviceId: machine.deviceId, before: { name: note.title, path: note.path } }))
            toast(t('memory.deleted'), 'success')
          }}
        />

    </div>
  )
}
