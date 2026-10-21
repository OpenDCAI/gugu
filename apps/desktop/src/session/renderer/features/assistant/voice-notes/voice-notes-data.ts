// #7199 语音笔记的读:云电脑上 <记忆夹>/voice-notes/ 每条一个文件夹(格式见 @gugu/core/shared/voiceNotes),
// 再叠上这一窗口里正在跑的那几条的进度(voice-note-jobs)—— 本机跑着的以本机为准,别处录的看文件。
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import {
  parseTranscript,
  parseVoiceNoteMeta,
  serializeVoiceNoteMeta,
  summaryTitle,
  voiceNoteView,
  VOICE_NOTE_META_FILE,
  VOICE_NOTE_SUMMARY_FILE,
  VOICE_NOTE_TRANSCRIPT_FILE,
  type TranscriptLine,
  type VoiceNoteMeta,
  type VoiceNoteView,
} from '@gugu/core/shared/voiceNotes';
import { assistantQueryKey } from '../assistant-data';
import { joinPath } from '../assistant-files';
import { listDirectory, readText, writeText, type AssistantMachine } from '../assistant-machine';
import { voiceJobs, voiceNoteDir, voiceNotesDir, type VoiceJobView } from './voice-note-jobs';

export type VoiceNoteItem = {
  id: string;
  /** note.json 读不出来 = null(仍列出来,能删)。 */
  meta: VoiceNoteMeta | null;
  view: VoiceNoteView;
  title: string | null;
  createdAt: string;
};

/** 本机正在跑的进度 → 要画的那一种(盖过云电脑上的文件:文件只在每一步结束时才写)。 */
export function jobView(job: VoiceJobView): VoiceNoteView {
  if (job.phase === 'ready') return { kind: 'ready', title: job.title };
  if (job.phase === 'no_speech') return { kind: 'no_speech' };
  if (job.phase === 'failed')
    return {
      kind: 'failed',
      stage: job.failure?.stage ?? 'transcribe',
      retryable: job.failure?.retryable ?? true,
      message: job.failure?.message ?? '',
      notice: job.failure?.notice ?? null,
      code: job.failure?.code ?? null,
    };
  return { kind: 'processing', phase: job.phase };
}

export function useVoiceJobs(): readonly VoiceJobView[] {
  return useSyncExternalStore(voiceJobs.subscribe, voiceJobs.getSnapshot);
}

/** id 是录音开始的时刻(voiceNoteId);note.json 读不出来时拿它排序。 */
function createdFromId(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : '';
}

/** 读一条;交给助理之后、它写好了而 note.json 还没改(写的那一端已经不在)→ 顺手把标题抄回去。 */
async function readNote(machine: AssistantMachine, id: string, now: number): Promise<VoiceNoteItem> {
  const dir = voiceNoteDir(machine, id);
  const meta = parseVoiceNoteMeta((await readText(machine, joinPath(dir, VOICE_NOTE_META_FILE))) ?? '');
  if (!meta) {
    return {
      id,
      meta: null,
      view: { kind: 'failed', stage: 'transcribe', retryable: false, message: 'unreadable', notice: null, code: null },
      title: null,
      createdAt: createdFromId(id),
    };
  }
  let summary: string | null | undefined;
  if (meta.status === 'summarizing' || meta.status === 'failed') {
    const text = await readText(machine, joinPath(dir, VOICE_NOTE_SUMMARY_FILE));
    summary = text?.trim() ? summaryTitle(text) : undefined;
    if (summary !== undefined && !voiceJobs.get(id)) {
      const ready = { ...meta, status: 'ready' as const, title: summary || null, failure: null, updatedAt: new Date(now).toISOString() };
      await writeText(machine, joinPath(dir, VOICE_NOTE_META_FILE), serializeVoiceNoteMeta(ready)).catch(() => undefined);
    }
  }
  const view = voiceNoteView(meta, summary, now);
  return { id, meta, view, title: view.kind === 'ready' ? view.title : meta.title, createdAt: meta.createdAt };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    })
  );
  return out;
}

/** queued(手机录的、等人点「开始转写」)不算处理中:没有谁在写进度,❌ 因它 5 秒一读。 */
function anyProcessing(items: readonly VoiceNoteItem[] | undefined): boolean {
  return !!items?.some((item) => item.view.kind === 'processing');
}

export function useVoiceNotes(machine: AssistantMachine | undefined) {
  return useQuery<VoiceNoteItem[]>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'voice', 'list'),
    queryFn: async () => {
      const m = machine!;
      const entries = await listDirectory(m, voiceNotesDir(m));
      const dirs = entries.filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'));
      const now = Date.now();
      return mapLimit(dirs, 6, (entry) => readNote(m, entry.name, now));
    },
    enabled: !!machine,
    refetchInterval: (query) => (anyProcessing(query.state.data) ? 5_000 : 30_000),
  });
}

export type VoiceNoteDetailData = { item: VoiceNoteItem; summary: string | null; lines: TranscriptLine[] } | null;

export function useVoiceNote(machine: AssistantMachine | undefined, id: string) {
  return useQuery<VoiceNoteDetailData>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'voice', 'note', id),
    queryFn: async () => {
      const m = machine!;
      const dir = voiceNoteDir(m, id);
      const meta = await readText(m, joinPath(dir, VOICE_NOTE_META_FILE));
      if (meta === null) return null;
      const item = await readNote(m, id, Date.now());
      const [summary, transcript] = await Promise.all([
        readText(m, joinPath(dir, VOICE_NOTE_SUMMARY_FILE)),
        readText(m, joinPath(dir, VOICE_NOTE_TRANSCRIPT_FILE)),
      ]);
      return { item, summary: summary?.trim() ? summary : null, lines: transcript ? parseTranscript(transcript) : [] };
    },
    enabled: !!machine && !!id,
    refetchInterval: (query) => (query.state.data?.item.view.kind === 'processing' ? 5_000 : false),
  });
}

/** 列表 / 详情要画的状态:本机跑着的以本机为准。 */
export function effectiveView(item: VoiceNoteItem, jobs: readonly VoiceJobView[]): VoiceNoteView {
  const job = jobs.find((j) => j.id === item.id);
  if (!job) return item.view;
  // 本机的进度说好了 / 失败 / 没人声,而文件已经是那个样 —— 文件为准(它带着标题)。
  if (job.phase === 'ready' && item.view.kind === 'ready') return item.view;
  return jobView(job);
}

/** 失败那一句:网关明说的原话 > 签票原因码的那一句 > 按环节的通用一句。 */
const FAILURE_CODES = new Set(['signed-out', 'membership-required', 'model-unavailable', 'unreachable', 'service-unavailable']);
export function failureText(
  t: (key: string, values?: Record<string, string>) => string,
  view: { stage: string; notice: string | null; code: string | null; message: string },
  name: string
): string {
  if (view.notice) return view.notice;
  if (view.code && FAILURE_CODES.has(view.code)) return t(`failure.code.${view.code}`);
  if (view.message === 'unreadable') return t('failure.unreadable');
  return t(`failure.${view.stage}`, { name });
}
