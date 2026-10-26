// #7199 一条语音笔记从录下到整理好(录 → 传 → 转写 → 生成笔记,失败可重试):
//   边录边把每段传到云电脑(<记忆夹>/voice-notes/<id>/audio/),有人声的段交主进程转写(网关,按积分计费)、
//   接进 transcript.md;录完转写齐了 → 交给个人助理(直接投进它自己那条会话,❌ 进聊天记录)写 summary.md,
//   这边等它写好再把 note.json 标成好了。每一步都把进度写进 note.json,换台电脑看也知道走到哪了。
// 一个窗口里的进度在这一份模块里(录音条、列表、详情都读它);App 关了再开,没走完的那条由人在列表里点重试接着做。
import { invokeOnMachine, rpcOn } from '@renderer/lib/ipc';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { homeSessions, homeTarget } from '../assistant-home-sessions';
import {
  looksHallucinated,
  newVoiceNoteMeta,
  parseModelTranscript,
  parseTranscript,
  parseVoiceNoteMeta,
  renderTranscript,
  retryStartsAt,
  segmentFileName,
  serializeVoiceNoteMeta,
  speakersOf,
  summaryRequestText,
  summaryTitle,
  transcriptionPrompt,
  transcriptTail,
  voiceNoteId,
  voiceNotesReadme,
  VOICE_NOTE_AUDIO_DIR,
  VOICE_NOTE_META_FILE,
  VOICE_NOTE_MIN_SEGMENT_VOICED_MS,
  VOICE_NOTE_MIN_TOTAL_VOICED_MS,
  VOICE_NOTE_SUMMARY_FILE,
  VOICE_NOTE_SUMMARY_TIMEOUT_MS,
  VOICE_NOTE_TRANSCRIPT_FILE,
  VOICE_NOTES_DIR,
  VOICE_NOTES_README_FILE,
  type TranscriptLine,
  type VoiceNoteFailure,
  type VoiceNoteFailureStage,
  type VoiceNoteMeta,
} from '@gugu/core/shared/voiceNotes';
import {
  VOICE_NOTE_RELEASE_CHANNEL,
  VOICE_NOTE_TRANSCRIBE_CHANNEL,
  type VoiceNoteTranscribeResult,
} from '@shared/core/voice-notes';
import { joinPath } from '../assistant-files';
import { isAssistantSession } from '../assistant-lineage';
import { makeFolder, readText, uploadFile, writeText, type AssistantMachine } from '../assistant-machine';
import type { MachineReadiness } from '../assistant-data';
import { base64ToBytes, segmentToWavBase64 } from './voice-note-audio';
import { voiceRecorder, type RecordedSegment, type RecorderError } from './voice-recorder';

// ── 此刻在跟哪位助理、它家哪台打交道(助理 App 每次渲染时交进来) ─────────────────────────────

export type VoiceNotesContext = {
  deviceId: string;
  /** 它住哪:眼前这台走本机,别的机器走那台的线(homeTarget)。 */
  home: AssistantHomePlace;
  assistantId: string;
  ownerName: string | null;
  machine: AssistantMachine | undefined;
  /** 现读(❌ 用助理 App 最后一次渲染时的那个):离开 App 之后云电脑睡了 / 醒了这里也知道。 */
  readiness: () => MachineReadiness;
  wake: () => void;
  prepareSummary?: () => Promise<{ session: { projectId: string; sessionId: string }; memoryDir: string }>;
  /** 云电脑上的文件变了:让列表 / 详情重读。 */
  invalidate: () => void;
};

let context: VoiceNotesContext | null = null;

export function setVoiceNotesContext(next: VoiceNotesContext | null) {
  context = next;
}

export function voiceNotesDir(machine: AssistantMachine): string {
  return joinPath(machine.paths.memoryDir, VOICE_NOTES_DIR);
}

export function voiceNoteDir(machine: AssistantMachine, id: string): string {
  return joinPath(voiceNotesDir(machine), id);
}

// ── 进度 ───────────────────────────────────────────────────────────────────────────

export type VoiceJobPhase = 'recording' | 'uploading' | 'transcribing' | 'summarizing' | 'ready' | 'failed' | 'no_speech';

export type VoiceJobView = {
  id: string;
  phase: VoiceJobPhase;
  failure: VoiceNoteFailure | null;
  title: string | null;
  /** 录音条上关掉了(进度照走,只是条子不再挂着)。 */
  dismissed: boolean;
  createdAt: string;
};

type PendingSegment = { file: string; blob: Blob | null; startMs: number; durationMs: number; voicedMs: number; uploaded: boolean; transcribed: boolean };

type Job = {
  id: string;
  meta: VoiceNoteMeta;
  segments: PendingSegment[];
  lines: TranscriptLine[];
  recordingDone: boolean;
  /** note.json 已经在云电脑上了。 */
  created: boolean;
  summaryRequested: boolean;
  running: boolean;
  /** 删掉了:不再往云电脑上写,也不再列出来。 */
  forgotten?: boolean;
  /** 第几轮(kick 一次加一)。 */
  runs?: number;
  view: VoiceJobView;
};

const jobs = new Map<string, Job>();
let snapshot: readonly VoiceJobView[] = [];
const listeners = new Set<() => void>();

function publish() {
  snapshot = [...jobs.values()].map((job) => job.view);
  for (const listener of listeners) listener();
}

function setView(job: Job, next: Partial<VoiceJobView>) {
  job.view = { ...job.view, ...next };
  publish();
}

export const voiceJobs = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  get: (id: string) => jobs.get(id)?.view ?? null,
  /** 录音条:关掉一条(进度照走)。 */
  dismiss(id: string) {
    const job = jobs.get(id);
    if (job) setView(job, { dismissed: true });
  },
  /** 删了这条:本窗口的进度一并丢掉(还在录就停下),❌ 让它再把文件写回去。 */
  forget(id: string) {
    const job = jobs.get(id);
    if (!job) return;
    job.forgotten = true;
    if (!job.recordingDone) voiceRecorder.stop();
    jobs.delete(id);
    publish();
  },
};

// ── 开始录 ─────────────────────────────────────────────────────────────────────────

export type StartOutcome = 'started' | 'busy' | 'no_assistant' | 'cancelled' | RecorderError;

/** 「+ → 录制语音笔记」/ 会议提醒「开始录音」。拿不到麦克风原因回给调用方说。 */
export async function startVoiceNote(meeting?: VoiceNoteMeta['meeting']): Promise<StartOutcome> {
  if (!context) return 'no_assistant';
  if (voiceRecorder.busy) return 'busy';
  let job: Job | null = null;
  const started = await voiceRecorder.start({
    onSegment: (segment) => {
      if (job) addSegment(job, segment);
    },
    onEnd: ({ durationMs }) => {
      // 麦克风半路没了(interrupted):已录的照常整理;录音机那边留着原因,录音条提示一句。
      if (job) finishRecording(job, durationMs);
    },
  });
  // 没开成又没有原因 = 人在「正在开始录音…」时点了取消。
  if (!started) return voiceRecorder.getSnapshot().error ?? 'cancelled';
  const now = new Date();
  const id = voiceNoteId(now, Math.random().toString(36).slice(2, 6));
  const meta = newVoiceNoteMeta({ id, createdAt: now, source: 'desktop', meeting: meeting ?? null });
  job = {
    id,
    meta,
    segments: [],
    lines: [],
    recordingDone: false,
    created: false,
    summaryRequested: false,
    running: false,
    view: { id, phase: 'recording', failure: null, title: null, dismissed: false, createdAt: meta.createdAt },
  };
  jobs.set(id, job);
  publish();
  if (context.readiness() === 'asleep') context.wake();
  kick(job);
  return 'started';
}

function addSegment(job: Job, segment: RecordedSegment) {
  job.segments.push({
    file: segmentFileName(segment.index, segment.extension),
    blob: segment.blob,
    startMs: segment.startMs,
    durationMs: segment.durationMs,
    voicedMs: segment.voicedMs,
    uploaded: false,
    transcribed: false,
  });
  job.segments.sort((a, b) => a.startMs - b.startMs);
  // 录着录着传失败了(网断了一下):新的一段来了就接着试,❌ 等人点重试。
  if (job.view.phase === 'failed' && !job.recordingDone) {
    job.meta = { ...job.meta, status: 'recording', failure: null };
    setView(job, { phase: 'recording', failure: null });
  }
  kick(job);
}

function finishRecording(job: Job, durationMs: number) {
  job.recordingDone = true;
  job.meta = { ...job.meta, durationMs, endedAt: new Date().toISOString(), status: 'transcribing', failure: null };
  setView(job, { phase: 'uploading' });
  kick(job);
}

// ── 重试(这一窗口里的,或云电脑上读到的那条) ─────────────────────────────────────────────

/** 列表 / 详情 / 录音条上的「重试」:从卡住的那一步接着做。本窗口没有它的进度就照云电脑上的文件重建一份。 */
export async function retryVoiceNote(id: string): Promise<void> {
  const existing = jobs.get(id);
  if (existing) {
    if (existing.running) return;
    existing.summaryRequested = false;
    existing.meta = { ...existing.meta, failure: null, status: existing.recordingDone ? 'transcribing' : 'recording' };
    setView(existing, { phase: existing.recordingDone ? 'uploading' : 'recording', failure: null, dismissed: false });
    kick(existing);
    return;
  }
  const ctx = context;
  const machine = ctx?.machine;
  if (!ctx || !machine) throw new Error('machine not ready');
  const dir = voiceNoteDir(machine, id);
  const meta = parseVoiceNoteMeta((await readText(machine, joinPath(dir, VOICE_NOTE_META_FILE))) ?? '');
  if (!meta) throw new Error('note.json unreadable');
  const transcript = await readText(machine, joinPath(dir, VOICE_NOTE_TRANSCRIPT_FILE));
  const job: Job = {
    id,
    // 没录完就断了的那条 note.json 里没有总时长:按传上去的段补上(交给助理时要说录了多久)。
    meta: { ...meta, failure: null, status: 'transcribing', durationMs: meta.durationMs || meta.segments.reduce((n, s) => Math.max(n, s.startMs + s.durationMs), 0) },
    segments: meta.segments.map((s) => ({ ...s, blob: null, uploaded: true })),
    lines: transcript ? parseTranscript(transcript) : [],
    recordingDone: true,
    created: true,
    summaryRequested: false,
    running: false,
    view: { id, phase: retryStartsAt(meta) === 'summarize' ? 'summarizing' : 'transcribing', failure: null, title: meta.title, dismissed: true, createdAt: meta.createdAt },
  };
  jobs.set(id, job);
  publish();
  kick(job);
}

// ── 干活 ───────────────────────────────────────────────────────────────────────────

class StepFailure extends Error {
  constructor(
    readonly stage: VoiceNoteFailureStage,
    message: string,
    /** 网关明说给人听的那句(拒绝时)。 */
    readonly notice: string | null = null,
    /** 签票那一步的原因码(没登录、要开会员……),界面按它说。 */
    readonly code: string | null = null
  ) {
    super(message);
  }
}

function kick(job: Job) {
  if (job.running || job.forgotten) return;
  job.running = true;
  const token = (job.runs = (job.runs ?? 0) + 1);
  void run(job).finally(() => {
    // 失败时 run 自己先放开了;那之后人点了重试又起了一轮,这里 ❌ 把新那一轮的标记抹掉。
    if (job.runs === token) job.running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等云电脑能读写:睡着就叫一次;录完之后还等不到 3 分钟就算传不上去。 */
async function waitMachine(job: Job): Promise<{ ctx: VoiceNotesContext; machine: AssistantMachine }> {
  let woke = false;
  let waitedSinceDone = 0;
  for (;;) {
    if (job.forgotten) throw new StepFailure('upload', 'forgotten');
    const ctx = context;
    const readiness = ctx?.readiness();
    if (ctx?.machine && readiness === 'ready') return { ctx, machine: ctx.machine };
    if (ctx && readiness === 'asleep' && !woke) {
      ctx.wake();
      woke = true;
    }
    if (job.recordingDone) {
      waitedSinceDone += 1_000;
      if (waitedSinceDone > 3 * 60_000) throw new StepFailure('upload', 'unreachable');
    }
    await sleep(1_000);
  }
}

async function saveMeta(job: Job, machine: AssistantMachine, patch: Partial<VoiceNoteMeta> = {}) {
  if (job.forgotten) throw new StepFailure('upload', 'forgotten');
  job.meta = {
    ...job.meta,
    ...patch,
    // 只记已经在云电脑上的段:没传上去的记进来,换个窗口重试就会去读一个不存在的文件。
    segments: job.segments.filter((s) => s.uploaded).map(({ file, startMs, durationMs, voicedMs, transcribed }) => ({ file, startMs, durationMs, voicedMs, transcribed })),
    updatedAt: new Date().toISOString(),
  };
  await writeText(machine, joinPath(voiceNoteDir(machine, job.id), VOICE_NOTE_META_FILE), serializeVoiceNoteMeta(job.meta));
}

async function ensureCreated(job: Job, machine: AssistantMachine) {
  if (job.created) return;
  const root = await makeFolder(machine, machine.paths.memoryDir, VOICE_NOTES_DIR);
  if (machine.panel || (await readText(machine, joinPath(root, VOICE_NOTES_README_FILE))) === null)
    await writeText(machine, joinPath(root, VOICE_NOTES_README_FILE), voiceNotesReadme());
  const dir = await makeFolder(machine, root, job.id);
  await makeFolder(machine, dir, VOICE_NOTE_AUDIO_DIR);
  await saveMeta(job, machine);
  job.created = true;
}

/** 云电脑上的一段录音读回来(这一窗口里没有它的字节时:重试、换了电脑)。 */
async function readBinary(machine: AssistantMachine, path: string): Promise<Blob> {
  if (machine.panel) {
    const bytes = await machine.panel.bytes(path);
    if (!bytes) throw new Error('The recording no longer exists');
    return new Blob([bytes.slice().buffer]);
  }
  const parts: BlobPart[] = [];
  let offset = 0;
  for (;;) {
    const result = await rpcOn(machine.target).workspace.files.readChunk(machine.projectId, machine.workspaceId, { path, offset, length: 512 * 1024 });
    if (!result.success) throw new Error(String(result.error.type));
    const bytes = base64ToBytes(result.data.data);
    parts.push(bytes.slice().buffer);
    offset += bytes.length;
    if (bytes.length === 0 || offset >= result.data.size) break;
  }
  return new Blob(parts);
}

async function transcribeSegment(job: Job, machine: AssistantMachine, ctx: VoiceNotesContext, segment: PendingSegment) {
  const blob = segment.blob ?? (await readBinary(machine, joinPath(voiceNoteDir(machine, job.id), segment.file)));
  const audioBase64 = await segmentToWavBase64(blob);
  const result = (await invokeOnMachine(null, VOICE_NOTE_TRANSCRIBE_CHANNEL, {
    agentUserId: ctx.assistantId,
    audioBase64,
    prompt: transcriptionPrompt(transcriptTail(job.lines)),
  })) as VoiceNoteTranscribeResult;
  if (!result.ok)
    throw new StepFailure('transcribe', `${result.code}: ${result.message}`, result.code === 'refused' ? result.message : null, result.code === 'refused' || result.code === 'failed' ? null : result.code);
  const lines = parseModelTranscript(result.text, segment.startMs);
  // 先写成文件再记进内存:写失败重试这一段时,❌ 同样几行再接一遍(也 ❌ 再付一次转写的钱之外还多出重复的行)。
  // 这一段从前转过(换了窗口重试、上次记进度没成)留下的行先拿掉,换成这一次的。
  const end = segment.startMs + segment.durationMs;
  const kept = job.lines.filter((l) => l.startMs < segment.startMs || l.startMs >= end);
  const next = looksHallucinated(lines, segment.durationMs) ? kept : [...kept, ...lines].sort((a, b) => a.startMs - b.startMs);
  if (job.forgotten) return;
  try {
    await writeText(machine, joinPath(voiceNoteDir(machine, job.id), VOICE_NOTE_TRANSCRIPT_FILE), renderTranscript(next));
  } catch (error) {
    throw new StepFailure('upload', error instanceof Error ? error.message : String(error));
  }
  job.lines = next;
}

/** 助理自己那条会话(按身份认);它的会话目录还没读到 = null。 */
function assistantSession(ctx: VoiceNotesContext): { projectId: string; sessionId: string } | null {
  const own = homeSessions(ctx.home).sessions.find((session) => isAssistantSession(session, ctx.assistantId));
  return own ? { projectId: own.projectId, sessionId: own.conversationId } : null;
}

async function requestSummary(job: Job, machine: AssistantMachine, ctx: VoiceNotesContext) {
  await saveMeta(job, machine, { status: 'summarizing', summaryRequestedAt: new Date().toISOString(), failure: null });
  try {
    const execution = await ctx.prepareSummary?.();
    const session = execution?.session ?? assistantSession(ctx);
    if (!session) throw new StepFailure('summarize', 'assistant-session-missing');
    const dir = execution ? joinPath(joinPath(execution.memoryDir, VOICE_NOTES_DIR), job.id) : voiceNoteDir(machine, job.id);
    await rpcOn(homeTarget(ctx.home)).sessions.sendMessage({
      projectId: session.projectId,
      sessionId: session.sessionId,
      clientMessageId: crypto.randomUUID(),
      kind: 'session-direct',
      text: summaryRequestText({
        dir,
        ownerName: ctx.ownerName,
        createdAt: job.meta.createdAt,
        durationMs: job.meta.durationMs,
        speakers: speakersOf(job.lines).length,
        meetingTitle: job.meta.meeting?.title ?? null,
      }),
    });
  } catch (error) {
    throw new StepFailure('summarize', error instanceof Error ? error.message : String(error));
  }
  job.summaryRequested = true;
}

/** 等助理写好 summary.md;写好了把标题抄进 note.json。 */
async function awaitSummary(job: Job) {
  const asked = Date.parse(job.meta.summaryRequestedAt ?? '') || Date.now();
  for (;;) {
    if (job.forgotten) return;
    const ctx = context;
    if (ctx?.machine && ctx.readiness() === 'ready') {
      const machine = ctx.machine;
      const text = await readText(machine, joinPath(voiceNoteDir(machine, job.id), VOICE_NOTE_SUMMARY_FILE)).catch(() => null);
      if (text !== null && text.trim()) {
        const title = summaryTitle(text) || null;
        await saveMeta(job, machine, { status: 'ready', title, failure: null });
        setView(job, { phase: 'ready', title });
        ctx.invalidate();
        return;
      }
    }
    if (Date.now() - asked > VOICE_NOTE_SUMMARY_TIMEOUT_MS) throw new StepFailure('summarize', 'timeout');
    await sleep(5_000);
  }
}

async function run(job: Job) {
  try {
    for (;;) {
      const { ctx, machine } = await waitMachine(job);
      if (job.forgotten) return;
      await ensureCreated(job, machine);
      const dir = voiceNoteDir(machine, job.id);

      const toUpload = job.segments.find((s) => !s.uploaded);
      if (toUpload) {
        if (job.recordingDone) setView(job, { phase: 'uploading' });
        const name = toUpload.file.slice(VOICE_NOTE_AUDIO_DIR.length + 1);
        try {
          await uploadFile(machine, joinPath(dir, VOICE_NOTE_AUDIO_DIR), new File([toUpload.blob!], name, { type: toUpload.blob!.type }));
        } catch (error) {
          throw new StepFailure('upload', error instanceof Error ? error.message : String(error));
        }
        toUpload.uploaded = true;
        await saveMeta(job, machine, job.recordingDone ? { status: 'transcribing' } : {});
        ctx.invalidate();
        continue;
      }

      const toTranscribe = job.segments.find((s) => !s.transcribed);
      if (toTranscribe) {
        if (job.recordingDone) setView(job, { phase: 'transcribing' });
        if (toTranscribe.voicedMs >= VOICE_NOTE_MIN_SEGMENT_VOICED_MS) await transcribeSegment(job, machine, ctx, toTranscribe);
        toTranscribe.transcribed = true;
        // 传上去、转写完的那一段,字节就不在内存里留了(重试时从云电脑读回来)。
        toTranscribe.blob = null;
        await saveMeta(job, machine);
        continue;
      }

      if (!job.recordingDone) return;
      void invokeOnMachine(null, VOICE_NOTE_RELEASE_CHANNEL, ctx.assistantId).catch(() => undefined);

      const voiced = job.segments.reduce((n, s) => n + s.voicedMs, 0);
      if (job.lines.length === 0 || voiced < VOICE_NOTE_MIN_TOTAL_VOICED_MS) {
        await saveMeta(job, machine, { status: 'no_speech', failure: null });
        setView(job, { phase: 'no_speech' });
        ctx.invalidate();
        return;
      }
      // 重试时助理可能早写好了(晚到的那份):有了就收下,❌ 再叫它写一遍、再发一条「整理好了」。
      const written = await readText(machine, joinPath(dir, VOICE_NOTE_SUMMARY_FILE)).catch(() => null);
      if (!job.summaryRequested && !written?.trim()) {
        setView(job, { phase: 'summarizing' });
        await requestSummary(job, machine, ctx);
        ctx.invalidate();
      }
      await awaitSummary(job);
      return;
    }
  } catch (error) {
    if (job.forgotten) return;
    // 没标环节的多半是读写云电脑那一步(note.json、建文件夹)没成:算「上传」。
    const failure: VoiceNoteFailure =
      error instanceof StepFailure
        ? { stage: error.stage, message: error.message, retryable: true, notice: error.notice, code: error.code }
        : { stage: 'upload', message: error instanceof Error ? error.message : String(error), retryable: true };
    // 先放开「在跑」:失败记进云电脑那一下可能要等很久(多半正是它连不上),这期间点「重试」要立刻生效。
    job.running = false;
    setView(job, { phase: 'failed', failure, dismissed: false });
    const ctx = context;
    if (ctx?.machine && job.created) {
      const machine = ctx.machine;
      void saveMeta(job, machine, { status: 'failed', failure })
        .catch(() => undefined)
        .finally(() => ctx.invalidate());
    }
  }
}
