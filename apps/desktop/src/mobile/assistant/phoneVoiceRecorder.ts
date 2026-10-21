// #7199 手机的语音笔记录音机(照桌面 voice-recorder.ts 的外形:一份、start / pause / resume / stop、快照可订):
// 麦克风 → PCM 帧 → 16k 单声道 WAV,每 5 分钟一段(phoneVoicePcm),边录边把段交出去(上传、转写在 phoneVoiceJobs.ts)。
// 麦克风怎么开(WebAudio)与「录音机本身」分开:后者吃一个 CaptureBackend,单测喂假的,❌ 碰真麦克风。
import { VOICE_NOTE_SEGMENT_MS } from '@gugu/core/shared/voiceNotes'
import { PcmSegmenter, type PcmSegment } from './phoneVoicePcm'

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
/** mic_denied = 系统没给麦克风;mic_missing = 没有麦克风;interrupted = 录到一半麦克风没了(已录的照常交出去)。 */
export type RecorderError = 'mic_denied' | 'mic_missing' | 'capture_failed' | 'interrupted'

export type RecorderSnapshot = {
  phase: RecorderPhase
  elapsedMs: number
  /** 0–1,录音条上那几根波形条的高度。 */
  level: number
  /** 连着多久几乎没声音(「未检测到声音」)。 */
  silentMs: number
  error: RecorderError | null
}

export type RecordedSegment = {
  index: number
  blob: Blob
  extension: 'wav'
  startMs: number
  durationMs: number
  voicedMs: number
}

export type RecorderHandlers = {
  onSegment: (segment: RecordedSegment) => void
  onEnd: (info: { durationMs: number; interrupted: boolean }) => void
}

/** 开着的一路麦克风:它的帧采样率(录音机据此降到 16k),与关掉它。 */
export type CaptureSession = { sampleRate: number; stop: () => void }

/** 开不起来的原因(录音机原样当 error 报出去)。 */
export class MicOpenError extends Error {
  constructor(readonly failure: Exclude<RecorderError, 'interrupted'>) {
    super(failure)
    this.name = 'MicOpenError'
  }
}

export type CaptureBackend = {
  /** 开麦克风并开始推帧(Float32,-1..1,单声道);`onEnded` = 录到一半麦克风没了。失败抛 MicOpenError。 */
  open(onFrame: (frame: Float32Array) => void, onEnded: () => void): Promise<CaptureSession>
}

/**
 * getUserMedia 的失败 → 原因。安卓 WebView 里,系统没给麦克风时 Capacitor 的 BridgeWebChromeClient 对这次请求 deny(),
 * 页面拿到的就是 NotAllowedError(「不再询问」之后连系统框都不弹,直接是它)。
 */
export function micFailureOf(error: unknown): Exclude<RecorderError, 'interrupted'> {
  const name = typeof (error as { name?: unknown } | null)?.name === 'string' ? (error as { name: string }).name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'mic_denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'mic_missing'
  return 'capture_failed'
}

const IDLE: RecorderSnapshot = { phase: 'idle', elapsedMs: 0, level: 0, silentMs: 0, error: null }
/** 读数最多这么久更新一次(帧一秒二三十个,界面不用跟那么紧)。 */
const PUBLISH_EVERY_MS = 100

export class PhoneVoiceRecorder {
  private snapshot: RecorderSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private live: { session: CaptureSession; segmenter: PcmSegmenter; handlers: RecorderHandlers; interrupted: boolean; published: number } | null = null
  private cancelled = false

  constructor(
    private readonly backend: CaptureBackend,
    private readonly segmentMs: number = VOICE_NOTE_SEGMENT_MS,
  ) {}

  getSnapshot = (): RecorderSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(next: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  get busy(): boolean {
    return this.snapshot.phase !== 'idle'
  }

  clearError() {
    if (this.snapshot.error) this.set({ error: null })
  }

  /** 开始录:先问系统要麦克风(安卓第一次会弹框),再开录。拿不到麦克风 = false,原因在 snapshot.error。 */
  async start(handlers: RecorderHandlers): Promise<boolean> {
    if (this.busy) return false
    this.cancelled = false
    this.set({ ...IDLE, phase: 'starting' })
    let session: CaptureSession
    try {
      session = await this.backend.open(
        (frame) => this.onFrame(frame),
        () => this.interrupt(),
      )
    } catch (error) {
      this.set({ phase: 'idle', error: error instanceof MicOpenError ? error.failure : 'capture_failed' })
      return false
    }
    if (this.cancelled) {
      session.stop()
      this.set(IDLE)
      return false
    }
    this.live = {
      session,
      handlers,
      interrupted: false,
      published: 0,
      segmenter: new PcmSegmenter(
        session.sampleRate,
        (segment: PcmSegment) =>
          handlers.onSegment({ index: segment.index, blob: segment.wav, extension: 'wav', startMs: segment.startMs, durationMs: segment.durationMs, voicedMs: segment.voicedMs }),
        this.segmentMs,
      ),
    }
    this.set({ phase: 'recording' })
    return true
  }

  /** 还在「正在开始录音…」时按了取消。 */
  cancel() {
    if (this.snapshot.phase === 'starting') this.cancelled = true
  }

  pause() {
    if (!this.live || this.snapshot.phase !== 'recording') return
    this.set({ phase: 'paused', level: 0 })
  }

  resume() {
    if (!this.live || this.snapshot.phase !== 'paused') return
    this.set({ phase: 'recording' })
  }

  stop() {
    if (this.snapshot.phase !== 'recording' && this.snapshot.phase !== 'paused') return
    this.finish()
  }

  private interrupt() {
    if (!this.live) return
    this.live.interrupted = true
    this.stop()
  }

  private onFrame(frame: Float32Array) {
    const live = this.live
    // 暂停 / 正在收尾时到的帧直接丢:录的时间只按收下的样本算。
    if (!live || this.snapshot.phase !== 'recording') return
    const meter = live.segmenter.push(frame)
    if (meter.elapsedMs - live.published >= PUBLISH_EVERY_MS) {
      live.published = meter.elapsedMs
      this.set({ elapsedMs: meter.elapsedMs, level: meter.level, silentMs: meter.silentMs })
    }
  }

  private finish() {
    const live = this.live
    if (!live) return
    this.set({ phase: 'stopping', level: 0 })
    this.live = null
    live.session.stop()
    live.segmenter.cut()
    const durationMs = live.segmenter.meter.elapsedMs
    this.set({ ...IDLE, error: live.interrupted ? 'interrupted' : null })
    live.handlers.onEnd({ durationMs, interrupted: live.interrupted })
  }
}

// ── 真麦克风:WebAudio ───────────────────────────────────────────────────────────

/** 把麦克风的帧攒成 2048 样本一包推回主线程的 worklet(音频线程上跑,主线程卡一下不丢帧)。 */
const TAP_PROCESSOR = `
class GuguVoiceTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) {
          const out = this.buffer;
          this.buffer = new Float32Array(2048);
          this.filled = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor('gugu-voice-tap', GuguVoiceTap);
`

async function createTap(context: AudioContext, onFrame: (frame: Float32Array) => void): Promise<{ node: AudioNode; dispose: () => void }> {
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(context, 'gugu-voice-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data)
      return { node, dispose: () => { node.port.onmessage = null; node.disconnect() } }
    } catch {
      // 这个 WebView 不让加载 worklet:退回 ScriptProcessor(主线程上跑,老一点但处处有)。
    }
  }
  const node = context.createScriptProcessor(4096, 1, 1)
  node.onaudioprocess = (event) => onFrame(new Float32Array(event.inputBuffer.getChannelData(0)))
  return { node, dispose: () => { node.onaudioprocess = null; node.disconnect() } }
}

/** 录音时别让屏幕自己熄(熄屏后安卓会把 WebView 与麦克风一起挂起);拿不到就算了,❌ 为它失败。 */
function holdScreenAwake(): () => void {
  if (typeof document === 'undefined') return () => undefined
  let sentinel: WakeLockSentinel | null = null
  let released = false
  const acquire = () => {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }).wakeLock
    if (released || !wakeLock) return
    void wakeLock.request('screen').then((next) => { sentinel = next }).catch(() => undefined)
  }
  // 页面回到前台时系统已经放掉了它:再要一次。
  const onVisible = () => { if (document.visibilityState === 'visible') acquire() }
  document.addEventListener('visibilitychange', onVisible)
  acquire()
  return () => {
    released = true
    document.removeEventListener('visibilitychange', onVisible)
    void sentinel?.release().catch(() => undefined)
  }
}

export const webAudioBackend: CaptureBackend = {
  async open(onFrame, onEnded) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicOpenError('capture_failed')
    // 上下文在点击的那一拍里就建好(系统授权框弹出之后用户激活就过期了,再建可能起不来),之后才去要麦克风。
    let context: AudioContext
    try {
      // 直接要 16k:Chromium 在上下文里把麦克风重采样好,少一道自己的降采样;不认就用设备的采样率,降采样在 PcmSegmenter。
      try {
        context = new AudioContext({ sampleRate: 16_000 })
      } catch {
        context = new AudioContext()
      }
    } catch {
      throw new MicOpenError('capture_failed')
    }
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (error) {
      void context.close().catch(() => undefined)
      throw new MicOpenError(micFailureOf(error))
    }
    let tap: { node: AudioNode; dispose: () => void } | null = null
    let releaseScreen: (() => void) | null = null
    const teardown = () => {
      releaseScreen?.()
      tap?.dispose()
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
    }
    try {
      // 页面被挂起又回来 / 被系统打断:上下文停了就接着跑,否则这之后的帧全是 0。
      context.addEventListener('statechange', () => {
        if (context.state === 'suspended' || (context.state as string) === 'interrupted') void context.resume().catch(() => undefined)
      })
      tap = await createTap(context, onFrame)
      const source = context.createMediaStreamSource(stream)
      const sink = context.createGain()
      sink.gain.value = 0
      source.connect(tap.node)
      tap.node.connect(sink)
      sink.connect(context.destination)
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', onEnded)
      releaseScreen = holdScreenAwake()
      return { sampleRate: context.sampleRate, stop: teardown }
    } catch {
      teardown()
      throw new MicOpenError('capture_failed')
    }
  },
}
