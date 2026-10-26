// #7199 语音笔记的录音机(聊天框「+ → 录音」):这台电脑的麦克风,录成每 5 分钟一段、每段自己能单独解码的
// webm(段与段之间换一台 MediaRecorder,不靠拼接),边录边把段交出去(上传、转写在 voice-note-jobs.ts)。
// 一个窗口同时只录一条:模块里一份,离开助理 App 也接着录,回来还看得到录音条。
import { invokeOnMachine } from '@renderer/lib/ipc';
import { VOICE_NOTE_SEGMENT_MS } from '@gugu/core/shared/voiceNotes';
import {
  VOICE_NOTE_MICROPHONE_CHANNEL,
  type VoiceNoteMicrophoneStatus,
} from '@shared/core/voice-notes';

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';
/** mic_denied = 系统没给麦克风;mic_missing = 没有麦克风;interrupted = 录到一半麦克风没了(已录的照常交出去)。 */
export type RecorderError = 'mic_denied' | 'mic_missing' | 'capture_failed' | 'interrupted';

export type RecorderSnapshot = {
  phase: RecorderPhase;
  elapsedMs: number;
  /** 0–1,录音条上那几根波形条的高度。 */
  level: number;
  /** 连着多久几乎没声音(「未检测到声音」)。 */
  silentMs: number;
  error: RecorderError | null;
  cause?: unknown;
};

export type RecordedSegment = {
  index: number;
  blob: Blob;
  extension: string;
  startMs: number;
  durationMs: number;
  voicedMs: number;
};

export type RecorderHandlers = {
  onSegment: (segment: RecordedSegment) => void;
  onEnd: (info: { durationMs: number; interrupted: boolean }) => void;
};

/** 比这响就算有人在说话(经过系统的降噪 / 自动增益之后的读数)。 */
const VOICE_RMS = 0.015;
/** 比这还轻 = 几乎没声音(麦克风静音、拔了)。 */
const SILENT_RMS = 0.002;
const TICK_MS = 100;

const MIME_CANDIDATES: readonly [string, string][] = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/mp4', 'm4a'],
];

function pickMime(): [string, string] | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find(([type]) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** 正在录的那一段:它自己的 MediaRecorder 与收到的块;停下时把量好的时长与有声时长一起交出去。 */
type Run = { recorder: MediaRecorder; index: number; startMs: number; voicedMs: number; durationMs: number | null };

type Live = {
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  mime: [string, string];
  run: Run | null;
  lastTick: number;
  timer: ReturnType<typeof setInterval>;
  handlers: RecorderHandlers;
  pendingStops: Promise<void>[];
  interrupted: boolean;
  /** 换段失败后,录到这一刻之前不再试。 */
  rotateAfterMs: number;
};

const IDLE: RecorderSnapshot = { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null };

class VoiceRecorder {
  private snapshot: RecorderSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private live: Live | null = null;
  private cancelled = false;

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  get busy(): boolean {
    return this.snapshot.phase !== 'idle';
  }

  clearError() {
    if (this.snapshot.error) this.set({ error: null, cause: undefined });
  }

  /** 开始录:先问系统要麦克风(macOS 第一次会弹框),再开录。拿不到麦克风 = false,原因在 snapshot.error。 */
  async start(handlers: RecorderHandlers): Promise<boolean> {
    if (this.busy) return false;
    this.cancelled = false;
    this.set({ ...IDLE, phase: 'starting' });
    const mime = pickMime();
    if (!mime) {
      this.set({ phase: 'idle', error: 'capture_failed', cause: new Error('This device does not support the available audio recording formats.') });
      return false;
    }
    const permission = (await invokeOnMachine(null, VOICE_NOTE_MICROPHONE_CHANNEL, 'request').catch(() => 'granted')) as VoiceNoteMicrophoneStatus;
    if (permission === 'denied') {
      this.set({ phase: 'idle', error: 'mic_denied' });
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      this.set({ phase: 'idle', cause: error, error: name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mic_missing' : name === 'NotAllowedError' ? 'mic_denied' : 'capture_failed' });
      return false;
    }
    if (this.cancelled) {
      for (const track of stream.getTracks()) track.stop();
      this.set(IDLE);
      return false;
    }
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      context = new AudioContext();
      // 窗口在后台时建的 AudioContext 可能是挂起的:那样读数全是 0,有声音也会被当成「没人声」。
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const live: Live = {
        stream,
        context,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        mime,
        run: null,
        lastTick: performance.now(),
        timer: (timer = setInterval(() => this.tick(), TICK_MS)),
        handlers,
        pendingStops: [],
        interrupted: false,
        rotateAfterMs: 0,
      };
      live.run = this.openSegment(live, 0, 0);
      this.live = live;
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => this.interrupt());
    } catch (error) {
      // 开不起来(编码器、音频设备出错):把麦克风还回去,回到没在录,❌ 卡在「正在开始录音…」。
      if (timer) clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      void context?.close().catch(() => undefined);
      this.live = null;
      this.set({ ...IDLE, error: 'capture_failed', cause: error });
      return false;
    }
    this.set({ phase: 'recording' });
    return true;
  }

  /** 还在「正在开始录音…」时按了取消。 */
  cancel() {
    if (this.snapshot.phase === 'starting') this.cancelled = true;
  }

  pause() {
    const live = this.live;
    if (!live || this.snapshot.phase !== 'recording') return;
    live.run?.recorder.pause();
    this.set({ phase: 'paused', level: 0 });
  }

  resume() {
    const live = this.live;
    if (!live || this.snapshot.phase !== 'paused') return;
    live.lastTick = performance.now();
    live.run?.recorder.resume();
    this.set({ phase: 'recording' });
  }

  stop() {
    if (this.snapshot.phase !== 'recording' && this.snapshot.phase !== 'paused') return;
    void this.finish();
  }

  private interrupt() {
    if (!this.live) return;
    this.live.interrupted = true;
    this.stop();
  }

  /** 新开一台 MediaRecorder 录下一段;它停下时把这一段交出去。 */
  private openSegment(live: Live, index: number, startMs: number): Run {
    const recorder = new MediaRecorder(live.stream, { mimeType: live.mime[0], audioBitsPerSecond: 32_000 });
    const run: Run = { recorder, index, startMs, voicedMs: 0, durationMs: null };
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    let settle: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      settle = resolve;
    });
    recorder.onstop = () => {
      if (chunks.length)
        live.handlers.onSegment({
          index,
          blob: new Blob(chunks, { type: live.mime[0] }),
          extension: live.mime[1],
          startMs,
          durationMs: run.durationMs ?? Math.max(0, this.snapshot.elapsedMs - startMs),
          voicedMs: run.voicedMs,
        });
      settle();
    };
    // 开起来了才算数:start 抛了(编码器出错)这一段就不存在,结束时 ❌ 等一个永远不会到的 onstop。
    recorder.start(1_000);
    live.pendingStops.push(stopped);
    return run;
  }

  /** 一段录满:先接上下一台再停这一台(宁可两段交界重叠几毫秒,也不漏)。 */
  private rotate(live: Live) {
    const previous = live.run;
    if (!previous) return;
    let next: Run;
    try {
      next = this.openSegment(live, previous.index + 1, this.snapshot.elapsedMs);
    } catch {
      // 下一台没开起来:这一段接着录(长一点,但不丢),半分钟后再试。
      live.rotateAfterMs = this.snapshot.elapsedMs + 30_000;
      return;
    }
    previous.durationMs = this.snapshot.elapsedMs - previous.startMs;
    live.run = next;
    previous.recorder.stop();
  }

  private tick() {
    const live = this.live;
    if (!live || this.snapshot.phase !== 'recording') return;
    const now = performance.now();
    const delta = Math.min(1_000, now - live.lastTick);
    live.lastTick = now;
    live.analyser.getFloatTimeDomainData(live.samples);
    let sum = 0;
    for (const sample of live.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / live.samples.length);
    if (rms > VOICE_RMS && live.run) live.run.voicedMs += delta;
    const level = rms <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 50));
    const elapsedMs = this.snapshot.elapsedMs + delta;
    this.set({ elapsedMs, level, silentMs: rms < SILENT_RMS ? this.snapshot.silentMs + delta : 0 });
    if (live.run && elapsedMs - live.run.startMs >= VOICE_NOTE_SEGMENT_MS && elapsedMs >= live.rotateAfterMs) this.rotate(live);
  }

  private async finish() {
    const live = this.live;
    if (!live) return;
    this.set({ phase: 'stopping', level: 0 });
    clearInterval(live.timer);
    const last = live.run;
    if (last) {
      last.durationMs = this.snapshot.elapsedMs - last.startMs;
      if (last.recorder.state !== 'inactive') last.recorder.stop();
    }
    await Promise.all(live.pendingStops);
    for (const track of live.stream.getTracks()) track.stop();
    void live.context.close().catch(() => undefined);
    this.live = null;
    const durationMs = this.snapshot.elapsedMs;
    this.set({ ...IDLE, error: live.interrupted ? 'interrupted' : null });
    live.handlers.onEnd({ durationMs, interrupted: live.interrupted });
  }
}

export const voiceRecorder = new VoiceRecorder();
