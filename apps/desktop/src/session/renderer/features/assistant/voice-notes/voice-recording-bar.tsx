import { messageForUser } from '@/lib/userFacingError';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import '@/i18n/registerVoiceNotesCatalog';
import './voice-notes.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatClock, type VoiceNoteMeta } from '@gugu/core/shared/voiceNotes';
import { ChevronRight, Pause, Play, RefreshCw, Square, X } from '@/lib/icons'
import { useQueryClient } from '@tanstack/react-query';
import { readAssistantShellBridge, type AssistantVoiceNoteHandler } from '@/lib/assistantShellBridge';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { VOICE_NOTE_MICROPHONE_CHANNEL } from '@shared/core/voice-notes';
import type { AssistantContext } from '../assistant-context';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { assistantQueryKey, homeReadiness, wakeAssistantMachine } from '../assistant-data';
import type { AssistantMachine } from '../assistant-machine';
import { retryVoiceNote, setVoiceNotesContext, startVoiceNote, voiceJobs, type VoiceJobView } from './voice-note-jobs';
import { failureText, useVoiceJobs } from './voice-notes-data';
import { voiceRecorder, type RecorderSnapshot } from './voice-recorder';

/** 「整理好了」那条挂多久(之后自己收起,笔记在记忆 → 语音笔记里)。 */
const READY_LINGER_MS = 15_000;
/** 连着这么久没声音就提示「未检测到声音」。 */
const NO_SOUND_HINT_MS = 8_000;
/** 7 根波形条的倍数。 */
const BARS = [0.75, 0.9, 0.8, 1, 0.8, 0.9, 0.75];

export function useRecorder(): RecorderSnapshot {
  return useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
}

/** 开始录一条;拿不到麦克风就照实说(没授权的给「打开系统设置」)。 */
export function useStartVoiceNote(): (meeting?: VoiceNoteMeta['meeting']) => Promise<boolean> {
  const { t } = useTranslation('voiceNotes');
  const { toast } = useToast();
  return useCallback(
    async (meeting) => {
      const outcome = await startVoiceNote(meeting);
      if (outcome === 'started') return true;
      const cause = voiceRecorder.getSnapshot().cause;
      voiceRecorder.clearError();
      if (outcome === 'mic_denied')
        toast({
          title: t('mic.denied'),
          tier: 'error',
          action: { label: t('mic.openSettings'), onClick: () => void invokeOnMachine(null, VOICE_NOTE_MICROPHONE_CHANNEL, 'open-settings') },
        });
      else if (outcome === 'mic_missing') toast({ title: t('mic.missing'), tier: 'error' });
      else if (outcome === 'busy') toast({ title: t('mic.busy'), tier: 'info' });
      else if (outcome !== 'no_assistant' && outcome !== 'cancelled') toast({ title: t('mic.failed'), description: messageForUser(cause), tier: 'error' });
      return false;
    },
    [t, toast]
  );
}

/**
 * 助理 App 挂上时:告诉录音机与进度此刻是哪位助理、它家是哪台;把「+ → 录制语音笔记」登记到桥上(壳那侧的聊天框)。
 * App 卸下时 ❌ 清掉上下文 —— 录到一半离开 App 也要接着传、接着转写;桥上的登记没在录就跟着卸下,在录就留着。
 */
export function useVoiceNotesHost(input: {
  home: AssistantHomePlace | null;
  assistantId: string | null;
  ownerName: string | null;
  machine: AssistantMachine | undefined;
}) {
  const client = useQueryClient();
  const start = useStartVoiceNote();
  const startRef = useRef(start);
  startRef.current = start;
  const { home, assistantId, ownerName, machine } = input;
  const deviceId = home?.deviceId ?? null;
  const homeKey = home ? JSON.stringify(home) : null;
  useEffect(() => {
    if (!home || !deviceId || !assistantId) return;
    setVoiceNotesContext({
      deviceId,
      home,
      assistantId,
      ownerName,
      machine,
      // homeReadiness 只是现读(不是 React hook),录音机在 App 外头也要现读,借它同一份判定。
      readiness: () => homeReadiness(home),
      // 住电脑没有「叫醒」:那台关着就是读不了,如实说。
      wake: () => {
        if (home.kind === 'cloud') void wakeAssistantMachine(deviceId);
      },
      invalidate: () => void client.invalidateQueries({ queryKey: assistantQueryKey(deviceId, 'voice') }),
    });
    // homeKey 代表 home 的内容(对象每次渲染是新的)。
  }, [homeKey, deviceId, assistantId, ownerName, machine, client]);
  useEffect(() => {
    const bridge = readAssistantShellBridge();
    if (!bridge || !deviceId || !assistantId) return;
    const handler: AssistantVoiceNoteHandler = {
      start: (meeting) => startRef.current(meeting ?? null),
      busy: () => voiceRecorder.busy,
      subscribe: voiceRecorder.subscribe,
    };
    bridge.setVoiceNoteHandler(handler);
    return () => {
      // 录着离开 App:登记留着 —— 壳那侧(栏上的红点、会议提醒)据此知道还在录;回到 App 时换成新的这一份。
      if (bridge.getVoiceNoteHandler() === handler && !voiceRecorder.busy) bridge.setVoiceNoteHandler(null);
    };
  }, [deviceId, assistantId]);
}

/** 录音条该跟着的那一条:最近开始的、没被关掉的;「好了」的只挂一会儿。 */
function barJob(jobs: readonly VoiceJobView[], now: number, readySince: Map<string, number>): VoiceJobView | null {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job.dismissed) continue;
    if (job.phase === 'ready' || job.phase === 'no_speech') {
      const since = readySince.get(job.id) ?? now;
      readySince.set(job.id, since);
      if (now - since > READY_LINGER_MS) continue;
    }
    return job;
  }
  return null;
}

/** 录音条摆在输入框上面:量出输入框那一排离这一列底边多高。 */
function useAboveComposer(column: HTMLElement | null): number {
  const [bottom, setBottom] = useState(88);
  useLayoutEffect(() => {
    if (!column) return;
    const measure = () => {
      const row = column.querySelector('[data-chat-composer-row]');
      if (!row) return;
      const gap = column.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
      if (gap > 0) setBottom(Math.round(gap + 10));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    const row = column.querySelector('[data-chat-composer-row]');
    if (row) observer.observe(row);
    const mutations = new MutationObserver(measure);
    mutations.observe(column, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [column]);
  return bottom;
}

/**
 * 录音条:录着 = 暂停 / 波形 / 计时 / 结束;暂停 = 继续 / 「已暂停」/ 计时 / 结束;
 * 录完 = 「正在处理音频… / 正在转写音频… / 正在生成语音笔记…」,点了去那一条;好了 = 「整理好了 · 查看」;失败 = 重试 / 关闭。
 */
export function VoiceRecordingBar({ context, column }: { context: AssistantContext; column: HTMLElement | null }) {
  const { t } = useTranslation('voiceNotes');
  const { toast } = useToast();
  const recorder = useRecorder();
  const jobs = useVoiceJobs();
  const readySince = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const anyJob = jobs.length > 0;
  useEffect(() => {
    if (!anyJob) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyJob]);
  // 麦克风半路没了(拔了耳机、换了设备):录音停在那儿,已录的照常整理 —— 说一句,❌ 悄悄变短。
  useEffect(() => {
    if (recorder.error !== 'interrupted') return;
    toast({ title: t('mic.interrupted'), tier: 'info' });
    voiceRecorder.clearError();
  }, [recorder.error, t, toast]);
  const job = barJob(jobs, now, readySince.current);
  const open = (id: string) => {
    voiceJobs.dismiss(id);
    context.go({ tab: 'memory', sub: `voice:${id}` });
  };

  let content: ReactNode = null;
  if (recorder.phase === 'starting') {
    content = (
      <>
        <LoadingIndicator size="inline" />
        <span className="vn-bar-label">{t('bar.starting')}</span>
        <button type="button" className="vn-bar-text-btn" onClick={() => voiceRecorder.cancel()}>
          {t('bar.cancel')}
        </button>
      </>
    );
  } else if (recorder.phase === 'recording' || recorder.phase === 'paused' || recorder.phase === 'stopping') {
    const paused = recorder.phase === 'paused';
    content = (
      <>
        <button
          type="button"
          className="vn-bar-btn"
          aria-label={paused ? t('bar.resume') : t('bar.pause')}
          title={paused ? t('bar.resume') : t('bar.pause')}
          onClick={() => (paused ? voiceRecorder.resume() : voiceRecorder.pause())}
          disabled={recorder.phase === 'stopping'}
          data-testid="assistant-voice-bar-pause"
        >
          {paused ? <Play /> : <Pause />}
        </button>
        {paused ? (
          <span className="vn-bar-label">{t('bar.paused')}</span>
        ) : (
          <span className="vn-wave" aria-label={t('bar.recording')} title={recorder.silentMs > NO_SOUND_HINT_MS ? t('bar.noSoundDescription') : undefined}>
            {BARS.map((mult, index) => (
              <span key={index} style={{ height: `${4 + recorder.level * mult * 20}px` }} />
            ))}
          </span>
        )}
        <span className="vn-clock" data-testid="assistant-voice-bar-clock">
          {formatClock(recorder.elapsedMs)}
        </span>
        {!paused && recorder.silentMs > NO_SOUND_HINT_MS ? <span className="vn-bar-hint" title={t('bar.noSoundDescription')}>{t('bar.noSound')}</span> : null}
        <button
          type="button"
          className="vn-bar-btn"
          data-tone="stop"
          aria-label={t('bar.stop')}
          title={t('bar.stop')}
          onClick={() => voiceRecorder.stop()}
          disabled={recorder.phase === 'stopping'}
          data-testid="assistant-voice-bar-stop"
        >
          <Square />
        </button>
      </>
    );
  } else if (job && job.phase !== 'recording') {
    if (job.phase === 'failed') {
      content = (
        <>
          <span className="vn-bar-label" data-tone="failed" title={job.failure?.notice || job.failure?.code ? failureText(t, { stage: job.failure.stage, notice: job.failure.notice ?? null, code: job.failure.code ?? null, message: job.failure.message }, context.assistant.display_name) : undefined}>
            {job.failure?.stage === 'upload' ? t('bar.failedUpload') : job.failure?.stage === 'summarize' ? t('bar.failedSummarize') : t('bar.failedTranscribe')}
          </span>
          <button type="button" className="vn-bar-text-btn" onClick={() => void retryVoiceNote(job.id)} data-testid="assistant-voice-bar-retry">
            <RefreshCw />
            {t('retry')}
          </button>
          <button type="button" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={() => voiceJobs.dismiss(job.id)}>
            <X />
          </button>
        </>
      );
    } else {
      const done = job.phase === 'ready' || job.phase === 'no_speech';
      const label =
        job.phase === 'ready' ? t('bar.ready') : job.phase === 'no_speech' ? t('bar.noSpeech') : t(`bar.${job.phase === 'summarizing' ? 'summarizing' : job.phase === 'transcribing' ? 'transcribing' : 'uploading'}`);
      content = (
        <>
          {done ? null : <LoadingIndicator size="inline" />}
          <button type="button" className="vn-bar-link" onClick={() => open(job.id)} data-testid="assistant-voice-bar-open">
            {label}
            {job.phase === 'ready' ? <span className="vn-bar-sub">{t('bar.open')}</span> : null}
            <ChevronRight />
          </button>
          {done ? (
            <button type="button" className="vn-bar-btn" aria-label={t('bar.close')} title={t('bar.close')} onClick={() => voiceJobs.dismiss(job.id)}>
              <X />
            </button>
          ) : null}
        </>
      );
    }
  }
  return <BarFrame column={column} phase={recorder.phase !== 'idle' ? recorder.phase : job?.phase}>{content}</BarFrame>;
}

/** 条子本身;挂着的时候给那一列打个记号(CSS 据此给消息列表底下让位),也只在挂着时量输入框的位置。 */
function BarFrame({ column, phase, children }: { column: HTMLElement | null; phase: string | undefined; children: ReactNode }) {
  const shown = children !== null;
  const bottom = useAboveComposer(shown ? column : null);
  useEffect(() => {
    if (!column || !shown) return;
    column.setAttribute('data-voice-bar', '');
    return () => column.removeAttribute('data-voice-bar');
  }, [column, shown]);
  if (!shown) return null;
  return (
    <div className="vn-bar" style={{ bottom }} data-testid="assistant-voice-bar" data-phase={phase}>
      {children}
    </div>
  );
}
