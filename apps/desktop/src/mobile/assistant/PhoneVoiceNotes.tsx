import '@/i18n/registerVoiceNotesCatalog'
import '@/session/renderer/features/assistant/voice-notes/voice-notes.css'
import './phone-memory.css'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { askAboutNoteDraft, formatTimestamp, groupVoiceNotesByWeek, speakersOf, summaryBody, type TranscriptLine, type VoiceNoteView, type VoiceNoteWeek } from '@gugu/core/shared/voiceNotes'
import { Markdown } from '@/components/markdown/Markdown'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { AlertCircle, MessageCircle, Trash2 } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneMachineView, ReadView, type OpenedPageProps } from './PhoneMachineView'
import { deleteVoiceNote, readVoiceNote, readVoiceNotes, voiceFailureText, voiceNoteDirOf, voicePollMs, type PhoneVoiceItem } from './phoneVoiceNotesData'
import { machineKey, usePhoneRead } from './usePhoneRead'

/**
 * 记忆 → 语音笔记(同桌面):`voice` 列表(按周分组,一条一张卡),`voice:<id>` 一条(总结 | 转写、就这次会议提问、删除)。
 * 只读它家里的文件,醒着才读得到(❌ 自己叫醒)。录音、转写、重新处理都在电脑那一侧,这里不摆。
 */
export function PhoneVoiceNotes(props: PhonePageProps) {
  const { t } = useTranslation('voiceNotes')
  const id = props.sub?.startsWith('voice:') ? props.sub.slice('voice:'.length) : null
  const name = props.assistant.display_name
  const ready = props.readiness === 'ready' && props.machine.state === 'ready' ? props.machine.machine : null
  if (ready && id) return <VoiceNoteDetail key={id} {...props} machine={ready} id={id} />
  return (
    <div className="ta-page" data-testid={id ? 'assistant-voice-note' : 'assistant-voice-notes'}>
      <PageHead title={t('title')} />
      <PhoneMachineView readiness={props.readiness} machine={props.machine} name={name}>
        {(machine) => (id ? null : <VoiceNotesList machine={machine} go={props.go} />)}
      </PhoneMachineView>
    </div>
  )
}

function useNoteTime() {
  const { t, i18n } = useTranslation('voiceNotes')
  return {
    /** 列表行:今天 17:00 / 9月7日 17:00。 */
    row(iso: string) {
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
      if (at.toDateString() === new Date().toDateString()) return t('today', { time })
      return new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
    },
    full(iso: string) {
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
    },
    week(week: VoiceNoteWeek) {
      if (week.kind !== 'range') return t(`week.${week.kind}`)
      const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(week.start.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }
      return new Intl.DateTimeFormat(i18n.language, options).formatRange(week.start, week.end)
    },
    duration(ms: number) {
      if (ms < 60_000) return t('seconds', { n: Math.max(1, Math.round(ms / 1000)) })
      return t('minutes', { n: Math.round(ms / 60_000) })
    },
  }
}

/** 行上那一小段状态:处理中 / 失败 / 未检测到语音 / 等转写(手机录的传上来了,转写在电脑上点「开始转写」)。 */
function StatusBadge({ view }: { view: VoiceNoteView }) {
  const { t } = useTranslation('voiceNotes')
  if (view.kind === 'processing')
    return (
      <span className="vn-status" data-tone={view.phase === 'recording' ? 'live' : 'busy'}>
        <span className="vn-dot" />
        {view.phase === 'recording' ? t('status.recording') : t('status.processing')}
      </span>
    )
  if (view.kind === 'failed')
    return (
      <span className="vn-status" data-tone="failed">
        <AlertCircle />
        {t('status.failed')}
      </span>
    )
  if (view.kind === 'no_speech') return <span className="vn-status">{t('status.noSpeech')}</span>
  if (view.kind === 'queued') return <span className="vn-status" data-testid="assistant-voice-status-queued">{t('status.queued')}</span>
  return null
}

function itemTitle(t: (key: string) => string, item: { title: string | null; view: VoiceNoteView }): string {
  if (item.title) return item.title
  return item.view.kind === 'processing' ? t('preparing') : t('untitled')
}

function VoiceNotesList({ machine, go }: { machine: AssistantMachine; go: PhonePageProps['go'] }) {
  const { t } = useTranslation('voiceNotes')
  const { t: ta } = useTranslation('assistant')
  const time = useNoteTime()
  const read = usePhoneRead(`voice|${machineKey(machine)}`, () => readVoiceNotes(machine), 'read voice notes', (items) =>
    voicePollMs(items.some((item) => item.view.kind === 'processing')),
  )
  return (
    <ReadView read={read} failedTitle={ta('memory.voiceLoadFailed')}>
      {(items: PhoneVoiceItem[]) =>
        items.length === 0 ? (
          <div className="ta-card">
            <AssistantEmpty title={ta('memory.voiceNotesEmptyTitle')} />
          </div>
        ) : (
          groupVoiceNotesByWeek(items, (item) => item.createdAt, new Date()).map((group) => (
            <section key={group.week.key} className="ta-section" data-testid={`assistant-voice-week-${group.week.kind}`}>
              <h2 className="vn-week">{time.week(group.week)}</h2>
              {group.items.map((item) => (
                <Button key={item.id} variant="ghost" className="vn-note" onClick={() => go(`voice:${item.id}`)} data-testid={`assistant-voice-note-${item.id}`}>
                  <span className="vn-note-title">{itemTitle(t, item)}</span>
                  <span className="vn-row-detail">
                    {time.row(item.createdAt)}
                    <StatusBadge view={item.view} />
                  </span>
                </Button>
              ))}
            </section>
          ))
        )
      }
    </ReadView>
  )
}

const SPEAKER_TONES = 3

/** 转写:一段一个说话人(圆点颜色按首次出现轮换)、时间、原话。 */
function TranscriptList({ lines }: { lines: readonly TranscriptLine[] }) {
  const { t } = useTranslation('voiceNotes')
  const speakers = speakersOf(lines)
  if (!lines.length) return <AssistantEmpty>{t('noTranscript')}</AssistantEmpty>
  return (
    <div className="vn-transcript" data-testid="assistant-voice-transcript">
      {lines.map((line, index) => (
        <article key={`${line.startMs}-${index}`} className="vn-line">
          <header>
            <span className="vn-speaker-dot" data-tone={speakers.indexOf(line.speaker) % SPEAKER_TONES} />
            <span className="vn-speaker">{line.speaker}</span>
            <span className="vn-stamp">{formatTimestamp(line.startMs)}</span>
          </header>
          <p>{line.text}</p>
        </article>
      ))}
    </div>
  )
}

/** 一条语音笔记:标题 + 录制时间;好了 = 总结 | 转写两栏 + 就这次会议提问;处理中 / 失败 / 没人声各说各的。 */
function VoiceNoteDetail({ machine, id, assistant, askInChat, go }: OpenedPageProps & { id: string }) {
  const { t } = useTranslation('voiceNotes')
  const { t: ta } = useTranslation('assistant')
  const time = useNoteTime()
  const { toast } = useToast()
  const name = assistant.display_name
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const [confirming, setConfirming] = useState(false)
  const read = usePhoneRead(`voice-note|${machineKey(machine)}|${id}`, () => readVoiceNote(machine, id), 'read voice note', (data) =>
    data && (data.item.view.kind === 'processing' || data.item.view.kind === 'queued') ? voicePollMs(data.item.view.kind === 'processing') : null,
  )
  // 在读 / 读失败(说是语音笔记没读到)/ 读到了却没有这一条(被删了)。
  if (read.state !== 'ok' || !read.data)
    return (
      <div className="ta-page" data-testid="assistant-voice-note">
        <PageHead title={t('title')} />
        <ReadView read={read} failedTitle={ta('memory.voiceLoadFailed')}>
          {() => <AssistantEmpty title={t('gone')} />}
        </ReadView>
      </div>
    )
  const { item, summary, lines } = read.data
  const view = item.view
  const title = itemTitle(t, item)
  const dir = voiceNoteDirOf(machine, id)
  const shortDir = dir.startsWith(machine.home) ? `~${dir.slice(machine.home.length)}` : dir
  const sub = [
    item.meta ? t('recordedAt', { time: time.full(item.meta.createdAt) }) : null,
    item.meta && item.meta.durationMs > 0 ? time.duration(item.meta.durationMs) : null,
    lines.length ? t('speakers', { count: speakersOf(lines).length }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const deleteButton = (
    <Button variant="ghost" className="ta-pill-btn" data-tone="danger" onClick={() => setConfirming(true)} data-testid="assistant-voice-delete">
      <Trash2 />
      {t('delete')}
    </Button>
  )
  const body = (() => {
    if (view.kind === 'processing')
      return (
        <div className="ta-card">
          <AssistantEmpty>
            <span className="inline-flex items-center gap-2">
              <LoadingIndicator size="inline" />
              {t(`phase.${view.phase}`, { name })}
            </span>
          </AssistantEmpty>
        </div>
      )
    if (view.kind === 'failed')
      return (
        <div className="ta-card" data-testid="assistant-voice-failed">
          <AssistantEmpty title={t('errorTitle')} action={deleteButton}>
            {voiceFailureText(t, view, name)}
          </AssistantEmpty>
        </div>
      )
    if (view.kind === 'no_speech')
      return (
        <div className="ta-card">
          <AssistantEmpty action={deleteButton}>{t('noSpeechDescription')}</AssistantEmpty>
        </div>
      )
    // 手机录的、传上来了、还没转写:转写在电脑上点「开始转写」,手机这一层没有它(❌ 放转写 / 重试按钮)。
    if (view.kind === 'queued')
      return (
        <div className="ta-card" data-testid="assistant-voice-queued">
          <AssistantEmpty title={t('status.queued')} action={deleteButton}>
            {t('queued.bodyPhone', { name })}
          </AssistantEmpty>
        </div>
      )
    return (
      <>
        <div className="ta-phone-page-segments">
          <SegmentedTabs
            items={[
              { value: 'summary', label: t('summary'), testId: 'assistant-seg-summary' },
              { value: 'transcript', label: t('transcript'), testId: 'assistant-seg-transcript' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel={title}
          />
        </div>
        {tab === 'summary' ? (
          <div className="ta-card ta-prose" data-testid="assistant-voice-summary">
            <Markdown trust="chat" content={summaryBody(summary ?? '')} />
          </div>
        ) : (
          <div className="ta-card">
            <TranscriptList lines={lines} />
          </div>
        )}
        <Button variant="ghost" className="vn-ask" onClick={() => askInChat(askAboutNoteDraft(title, shortDir))} data-testid="assistant-voice-ask">
          <MessageCircle />
          {t('ask')}
        </Button>
        <div className="ta-phone-row-actions">{deleteButton}</div>
      </>
    )
  })()
  return (
    <div className="ta-page" data-testid="assistant-voice-note">
      <PageHead title={title} sub={sub || undefined} />
      {body}
      <PhoneConfirmDialog
          open={confirming}
          title={t('deleteTitle', { name: title })}
          body={t('deleteBody')}
          confirmLabel={t('delete')}
          failedText={t('deleteFailed')}
          testId="assistant-voice-delete-dialog"
          onClose={() => setConfirming(false)}
          onConfirmed={() => go('voice')}
          onConfirm={async () => {
            await deleteVoiceNote(machine, id)
            toast(t('deleted'), 'success')
          }}
        />

    </div>
  )
}
