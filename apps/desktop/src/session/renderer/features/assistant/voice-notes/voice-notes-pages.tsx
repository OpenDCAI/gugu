import { messageForUser } from '@/lib/userFacingError';
import { safeFailureLine } from '../../sessions/gugu-reason';
import { log } from '@renderer/utils/logger';
import '@/i18n/registerVoiceNotesCatalog';
import './voice-notes.css';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  askAboutNoteDraft,
  exportFileName,
  exportMarkdown,
  groupVoiceNotesByWeek,
  speakersOf,
  summaryBody,
  formatTimestamp,
  type VoiceNoteView,
  type VoiceNoteWeek,
} from '@gugu/core/shared/voiceNotes';
import { AlertCircle, Copy, Download, MessageCircle, Mic, MoreHorizontal, RefreshCw, Trash2 } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { invokeOnMachine, rpc } from '@renderer/lib/ipc';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Switch } from '@renderer/lib/ui/switch';
import { meetingReminderEnabled, setMeetingReminderEnabled, subscribeMeetingReminderPref } from '@/lib/meetingReminderPref';
import { VOICE_NOTE_MEETINGS_CHANNEL, type VoiceNoteMeetingsResult } from '@shared/core/voice-notes';
import type { AssistantContext } from '../assistant-context';
import { useInvalidateAssistant } from '../assistant-data';
import { removePath } from '../assistant-machine';
import { AssistantEmpty, AssistantRow, AssistantSection, MachineGate, PageHead, WideSegments } from '../assistant-ui';
import { retryVoiceNote, voiceJobs, voiceNoteDir } from './voice-note-jobs';
import { effectiveView, failureText, jobView, useVoiceJobs, useVoiceNote, useVoiceNotes, type VoiceNoteItem } from './voice-notes-data';
import { useStartVoiceNote } from './voice-recording-bar';

/** 路由:`voice` = 列表,`voice:<id>` = 一条。 */
export const VOICE_NOTE_SUB = 'voice';

export function voiceNoteRoute(id: string): string {
  return `${VOICE_NOTE_SUB}:${id}`;
}

function useNoteTime() {
  const { t, i18n } = useTranslation('voiceNotes');
  return {
    /** 列表行:今天 17:00 / 9月7日 17:00。 */
    row(iso: string) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return '';
      const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
      const now = new Date();
      if (at.toDateString() === now.toDateString()) return t('today', { time });
      return new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
    },
    full(iso: string) {
      const at = new Date(iso);
      return Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
    },
    week(week: VoiceNoteWeek) {
      if (week.kind !== 'range') return t(`week.${week.kind}`);
      const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(week.start.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
      return new Intl.DateTimeFormat(i18n.language, options).formatRange(week.start, week.end);
    },
    duration(ms: number) {
      if (ms < 60_000) return t('seconds', { n: Math.max(1, Math.round(ms / 1000)) });
      return t('minutes', { n: Math.round(ms / 60_000) });
    },
  };
}

/** 行上那一小段状态(蓝点「处理中…」/ 红「失败」/「未检测到语音」;手机录的传上来了 =「等转写」)。 */
function StatusBadge({ view }: { view: VoiceNoteView }) {
  const { t } = useTranslation('voiceNotes');
  if (view.kind === 'processing')
    return (
      <span className="vn-status" data-tone={view.phase === 'recording' ? 'live' : 'busy'}>
        <span className="vn-dot" />
        {view.phase === 'recording' ? t('status.recording') : t('status.processing')}
      </span>
    );
  if (view.kind === 'failed')
    return (
      <span className="vn-status" data-tone="failed">
        <AlertCircle />
        {t('status.failed')}
      </span>
    );
  if (view.kind === 'no_speech') return <span className="vn-status">{t('status.noSpeech')}</span>;
  if (view.kind === 'queued') return <span className="vn-status" data-testid="assistant-voice-status-queued">{t('status.queued')}</span>;
  return null;
}

function itemTitle(t: (key: string) => string, item: { title: string | null }, view: VoiceNoteView): string {
  if (item.title) return item.title;
  return view.kind === 'processing' ? t('preparing') : t('untitled');
}

/** 列表:按周分组,一行一条,点进去看那一条。 */
function VoiceNotesList({ context }: { context: AssistantContext }) {
  const { t } = useTranslation('voiceNotes');
  const time = useNoteTime();
  const notes = useVoiceNotes(context.machine);
  const jobs = useVoiceJobs();
  const start = useStartVoiceNote();
  const items = useMemo(() => {
    const listed = notes.data ?? [];
    // 本机刚开始录、还没写到云电脑上的那条也列出来。
    const local: VoiceNoteItem[] = jobs
      .filter((job) => !listed.some((item) => item.id === job.id))
      .map((job) => ({ id: job.id, meta: null, view: jobView(job), title: job.title, createdAt: job.createdAt }));
    return [...listed, ...local].map((item) => ({ item, view: effectiveView(item, jobs) }));
  }, [notes.data, jobs]);
  const groups = groupVoiceNotesByWeek(items, (entry) => entry.item.createdAt, new Date());
  return (
    <div className="ta-page" data-testid="assistant-voice-notes">
      <PageHead
        title={t('title')}
        action={
          <button type="button" className="ta-circle" aria-label={t('record')} title={t('record')} onClick={() => void start()} data-testid="assistant-voice-record">
            <Mic />
          </button>
        }
      />
      <MachineGate hasData={notes.data !== undefined || items.length > 0}
        readiness={context.readiness}
        loading={context.machineLoading || notes.isLoading}
        error={context.machineError ?? notes.error}
        onRetry={() => (context.machineError ? context.retryMachine() : void notes.refetch())}
      >
        {items.length === 0 ? (
          <div className="ta-card">
            <AssistantEmpty
              title={t('emptyTitle')}
              action={
                <button type="button" className="ta-pill-btn" onClick={() => void start()}>
                  <Mic />
                  {t('record')}
                </button>
              }
            >
              {t('empty', { name: context.assistant.display_name })}
            </AssistantEmpty>
          </div>
        ) : (
          // 周标签是一行小字,一条一张玻璃卡(不是一张卡里分行),行尾没有 ›。
          groups.map((group) => (
            <section key={group.week.key} className="ta-section" data-testid={`assistant-voice-week-${group.week.kind}`}>
              <h2 className="vn-week">{time.week(group.week)}</h2>
              {group.items.map(({ item, view }) => (
                <button
                  key={item.id}
                  type="button"
                  className="vn-note"
                  data-testid={`assistant-voice-note-${item.id}`}
                  onClick={() => context.go({ tab: 'memory', sub: voiceNoteRoute(item.id) })}
                >
                  <span className="vn-note-title">{itemTitle(t, item, view)}</span>
                  <span className="vn-row-detail">
                    {time.row(item.createdAt)}
                    <StatusBadge view={view} />
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
      </MachineGate>
    </div>
  );
}

const SPEAKER_TONES = 3;

/** 转写:一段一个说话人(圆点颜色按首次出现轮换)、时间、原话。 */
function TranscriptList({ lines }: { lines: readonly { startMs: number; speaker: string; text: string }[] }) {
  const { t } = useTranslation('voiceNotes');
  const speakers = speakersOf(lines);
  if (!lines.length) return <AssistantEmpty>{t('noTranscript')}</AssistantEmpty>;
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
  );
}

/**
 * 一条语音笔记的详情:标题 + 录制时间;好了 = 总结 | 转写两栏 + 就这次会议提问;处理中 / 失败 / 没人声各说各的。
 * 手机录的传上来了、还没转写(queued)= 一个「开始转写」,走的就是重试那一条(从云上读回音频 → 转写 → 交给助理写总结)。
 */
function VoiceNoteDetail({ context, id }: { context: AssistantContext; id: string }) {
  const { t } = useTranslation('voiceNotes');
  const time = useNoteTime();
  const { toast } = useToast();
  const showConfirm = useShowModal('confirmActionModal');
  const invalidate = useInvalidateAssistant(context.homeDeviceId);
  const note = useVoiceNote(context.machine, id);
  const jobs = useVoiceJobs();
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
  const [retrying, setRetrying] = useState(false);
  const name = context.assistant.display_name;
  const localJob = jobs.find((job) => job.id === id) ?? null;
  const data = note.data;
  const view: VoiceNoteView | null = data ? effectiveView(data.item, jobs) : localJob ? jobView(localJob) : null;
  const title = data ? itemTitle(t, data.item, view ?? data.item.view) : localJob?.title ?? t('preparing');
  const meta = data?.item.meta ?? null;
  const machine = context.machine;
  const dir = machine ? voiceNoteDir(machine, id) : '';
  const shortDir = machine && dir.startsWith(machine.home) ? `~${dir.slice(machine.home.length)}` : dir;

  const remove = async () => {
    if (!machine) return;
    try {
      // 先停掉本窗口里这一条(还在写的那一下会把文件夹又建回来),再删。
      voiceJobs.forget(id);
      await removePath(machine, dir, true);
      await invalidate('voice');
      toast({ title: t('deleted') });
      context.go({ tab: 'memory', sub: VOICE_NOTE_SUB });
    } catch (error) { log.error({ error: error }, 'action failed');
      toast({ title: t('deleteFailed'), description: messageForUser(error), tier: 'error' });
    }
  };
  const confirmRemove = () =>
    showConfirm({
      title: t('deleteTitle', { name: title }),
      description: t('deleteBody'),
      confirmLabel: t('delete'),
      variant: 'destructive',
      onSuccess: () => void remove(),
    });
  const retry = async () => {
    setRetrying(true);
    try {
      await retryVoiceNote(id);
      await invalidate('voice');
    } catch (error) { log.error({ error: error }, 'action failed');
      toast({ title: t('retryFailed'), description: messageForUser(error), tier: 'error' });
    } finally {
      setRetrying(false);
    }
  };
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryBody(data?.summary ?? ''));
      toast({ title: t('summaryCopied') });
    } catch (error) {
      log.error({ error }, 'voice note summary copy failed');
      toast({ title: t('copyFailed'), description: safeFailureLine(String((error as Error)?.message ?? error)), tier: 'error' });
    }
  };
  const exportNote = async () => {
    try {
      const saved = await rpc.app.saveTextFile({ title: t('exportTitle'), defaultPath: exportFileName(title), content: exportMarkdown({ title, summary: data?.summary ?? null, lines: data?.lines ?? [] }) });
      if (!saved.success) { log.error('voice note export failed', { error: saved.error }); toast({ title: t('exportFailed'), description: messageForUser(saved.error), tier: 'error' }); }
      else if (saved.path) toast({ title: t('exported') });
    } catch (error) { log.error('voice note export failed', { error }); toast({ title: t('exportFailed'), description: messageForUser(error), tier: 'error' }); }
  };

  const sub = [
    meta ? t('recordedAt', { time: time.full(meta.createdAt) }) : localJob ? t('recordedAt', { time: time.full(localJob.createdAt) }) : null,
    meta && meta.durationMs > 0 ? time.duration(meta.durationMs) : null,
    data && data.lines.length ? t('speakers', { count: speakersOf(data.lines).length }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = () => {
    if (!view) return <AssistantEmpty title={t('gone')} />;
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
      );
    if (view.kind === 'failed' || view.kind === 'queued') {
      const queued = view.kind === 'queued';
      return (
        <div className="ta-card" data-testid={queued ? 'assistant-voice-queued' : 'assistant-voice-failed'}>
          <AssistantEmpty
            title={queued ? t('status.queued') : t('errorTitle')}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {queued || view.retryable ? (
                  <button type="button" className="ta-pill-btn" disabled={retrying} onClick={() => void retry()} data-testid={queued ? 'assistant-voice-start-transcribe' : 'assistant-voice-retry'}>
                    {queued ? <Mic /> : <RefreshCw />}
                    {queued ? t('queued.start') : t('retry')}
                  </button>
                ) : null}
                <button type="button" className="ta-pill-btn" data-tone="danger" onClick={confirmRemove}>
                  <Trash2 />
                  {t('delete')}
                </button>
              </div>
            }
          >
            {view.kind === 'queued' ? t('queued.bodyDesktop', { name }) : failureText(t, view, name)}
          </AssistantEmpty>
        </div>
      );
    }
    if (view.kind === 'no_speech')
      return (
        <div className="ta-card">
          <AssistantEmpty
            action={
              <button type="button" className="ta-pill-btn" data-tone="danger" onClick={confirmRemove}>
                <Trash2 />
                {t('delete')}
              </button>
            }
          >
            {t('noSpeechDescription')}
          </AssistantEmpty>
        </div>
      );
    return (
      <>
        <WideSegments<'summary' | 'transcript'>
          items={[
            { id: 'summary', label: t('summary') },
            { id: 'transcript', label: t('transcript') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'summary' ? (
          <div className="ta-card ta-prose" data-testid="assistant-voice-summary">
            <MarkdownRenderer content={summaryBody(data?.summary ?? '')} />
          </div>
        ) : (
          <div className="ta-card">
            <TranscriptList lines={data?.lines ?? []} />
          </div>
        )}
        <button
          type="button"
          className="vn-ask"
          onClick={() => context.askInChat(askAboutNoteDraft(title, shortDir))}
          data-testid="assistant-voice-ask"
        >
          <MessageCircle />
          {t('ask')}
        </button>
      </>
    );
  };

  return (
    <MachineGate hasData={!!note.data || !!localJob}
      readiness={context.readiness}
      loading={!localJob && (context.machineLoading || note.isLoading)}
      error={localJob ? null : context.machineError ?? note.error}
      onRetry={() => (context.machineError ? context.retryMachine() : void note.refetch())}
    >
      <div className="ta-page" data-testid="assistant-voice-note">
        <PageHead
          title={title}
          sub={sub || undefined}
          action={
            view?.kind === 'ready' ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t('more')} data-testid="assistant-voice-more" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void copySummary()}>
                    <Copy />
                    {t('copySummary')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportNote()}>
                    <Download />
                    {t('export')}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={confirmRemove}>
                    <Trash2 />
                    {t('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null
          }
        />
        {body()}
      </div>
    </MachineGate>
  );
}

/** 记忆 → 语音笔记这一格:列表,或往下钻到的那一条。 */
export function VoiceNotesPage({ context }: { context: AssistantContext }) {
  const sub = context.route.sub ?? '';
  if (sub.startsWith(`${VOICE_NOTE_SUB}:`)) return <VoiceNoteDetail key={sub} context={context} id={sub.slice(VOICE_NOTE_SUB.length + 1)} />;
  return <VoiceNotesList context={context} />;
}

/** 助理的设置页里那一段:入会提醒开关;日历没连上就照实说要先去连。 */
export function VoiceNoteSettings() {
  const { t } = useTranslation('voiceNotes');
  const enabled = useSyncExternalStore(subscribeMeetingReminderPref, meetingReminderEnabled);
  const [calendar, setCalendar] = useState<'ok' | 'missing' | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (invokeOnMachine(null, VOICE_NOTE_MEETINGS_CHANNEL) as Promise<VoiceNoteMeetingsResult>)
      .then((result) => {
        if (!cancelled) setCalendar(result.ok ? 'ok' : result.code === 'not_granted' || result.code === 'unsupported' || result.code === 'os_permission' ? 'missing' : 'ok');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <AssistantSection title={t('title')} testId="assistant-voice-settings">
      <AssistantRow
        title={t('meeting.setting')}
        detail={calendar === 'missing' ? t('meeting.needsCalendar') : t('meeting.settingDescription')}
        trailing={<Switch checked={enabled} onCheckedChange={(on) => setMeetingReminderEnabled(on)} aria-label={t('meeting.setting')} data-testid="assistant-meeting-reminder-switch" />}
      />
    </AssistantSection>
  );
}
