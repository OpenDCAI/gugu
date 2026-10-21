import { afterEach, describe, expect, it, vi } from 'vitest'
import { VOICE_NOTE_SEGMENT_MS } from '@gugu/core/shared/voiceNotes'
import {
  MicOpenError,
  micFailureOf,
  PhoneVoiceRecorder,
  webAudioBackend,
  type CaptureBackend,
  type RecordedSegment,
} from '../../../apps/desktop/src/mobile/assistant/phoneVoiceRecorder'

// #7199 手机的语音笔记录音机:开麦克风的结果(给了 / 没给 / 没有)、暂停不走表、按核心定的 5 分钟切段、半路没了照常交出已录的。
// 麦克风换成假的后端:测的是录音机的状态机与切段,❌ 碰真麦克风。

function fakeBackend(options: { open?: () => Promise<void> | void; sampleRate?: number } = {}) {
  const state = { onFrame: (_frame: Float32Array) => undefined as void, onEnded: () => undefined as void, stopped: 0, opened: 0 }
  const backend: CaptureBackend = {
    async open(onFrame, onEnded) {
      state.opened += 1
      await options.open?.()
      state.onFrame = onFrame
      state.onEnded = onEnded
      return { sampleRate: options.sampleRate ?? 16_000, stop: () => void (state.stopped += 1) }
    },
  }
  return { backend, state }
}

const frame = (samples: number, value = 0.3) => new Float32Array(samples).fill(value)

function collect() {
  const segments: RecordedSegment[] = []
  const ends: { durationMs: number; interrupted: boolean }[] = []
  return { segments, ends, handlers: { onSegment: (s: RecordedSegment) => void segments.push(s), onEnd: (e: { durationMs: number; interrupted: boolean }) => void ends.push(e) } }
}

describe('micFailureOf:系统没给麦克风要能认出来', () => {
  it('NotAllowedError(安卓 WebView 里权限被拒 / 不再询问)= 没给', () => {
    expect(micFailureOf(new DOMException('Permission denied', 'NotAllowedError'))).toBe('mic_denied')
    expect(micFailureOf({ name: 'PermissionDeniedError' })).toBe('mic_denied')
    expect(micFailureOf({ name: 'SecurityError' })).toBe('mic_denied')
  })

  it('没有麦克风 / 约束满足不了 = 没有;别的(被来电占着、硬件出错)= 开不起来', () => {
    expect(micFailureOf(new DOMException('no device', 'NotFoundError'))).toBe('mic_missing')
    expect(micFailureOf({ name: 'OverconstrainedError' })).toBe('mic_missing')
    expect(micFailureOf(new DOMException('busy', 'NotReadableError'))).toBe('capture_failed')
    expect(micFailureOf(new Error('boom'))).toBe('capture_failed')
    expect(micFailureOf(null)).toBe('capture_failed')
  })
})

describe('PhoneVoiceRecorder', () => {
  it('麦克风被拒:start 返回 false,原因是 mic_denied,回到没在录(❌ 卡在「正在开始」)', async () => {
    const { backend } = fakeBackend({
      open: () => {
        throw new MicOpenError(micFailureOf(new DOMException('denied', 'NotAllowedError')))
      },
    })
    const recorder = new PhoneVoiceRecorder(backend)
    const { handlers } = collect()
    await expect(recorder.start(handlers)).resolves.toBe(false)
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'idle', error: 'mic_denied' })
    expect(recorder.busy).toBe(false)
    recorder.clearError()
    expect(recorder.getSnapshot().error).toBeNull()
  })

  it('开起来后意外的错也回到没在录,原因是 capture_failed', async () => {
    const { backend } = fakeBackend({
      open: () => {
        throw new Error('audio device exploded')
      },
    })
    const recorder = new PhoneVoiceRecorder(backend)
    await expect(recorder.start(collect().handlers)).resolves.toBe(false)
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'idle', error: 'capture_failed' })
  })

  it('录 → 暂停(帧直接丢,时间不走)→ 继续 → 结束:交出最后一段与总时长', async () => {
    const { backend, state } = fakeBackend()
    const recorder = new PhoneVoiceRecorder(backend)
    const { segments, ends, handlers } = collect()
    await expect(recorder.start(handlers)).resolves.toBe(true)
    expect(recorder.getSnapshot().phase).toBe('recording')
    for (let i = 0; i < 10; i += 1) state.onFrame(frame(1_600)) // 1 秒
    expect(recorder.getSnapshot().elapsedMs).toBeCloseTo(1_000, 6)
    recorder.pause()
    expect(recorder.getSnapshot().phase).toBe('paused')
    for (let i = 0; i < 10; i += 1) state.onFrame(frame(1_600)) // 暂停期间到的
    expect(recorder.getSnapshot().elapsedMs).toBeCloseTo(1_000, 6)
    recorder.resume()
    for (let i = 0; i < 5; i += 1) state.onFrame(frame(1_600)) // 又 0.5 秒
    recorder.stop()
    expect(state.stopped).toBe(1)
    expect(recorder.getSnapshot().phase).toBe('idle')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ index: 0, extension: 'wav', startMs: 0 })
    expect(segments[0]!.durationMs).toBeCloseTo(1_500, 6)
    expect(segments[0]!.voicedMs).toBeCloseTo(1_500, 6)
    expect(ends).toEqual([{ durationMs: expect.closeTo(1_500, 6), interrupted: false }])
  })

  it('按核心定的 5 分钟一段:12 分钟 = 5 + 5 + 2,后一段起点接着前一段', async () => {
    const { backend, state } = fakeBackend()
    const recorder = new PhoneVoiceRecorder(backend)
    const { segments, handlers } = collect()
    await recorder.start(handlers)
    // 16k 单声道,每帧 1 秒(16000 样本),共 720 秒。
    const second = new Float32Array(16_000)
    for (let i = 0; i < 720; i += 1) state.onFrame(second)
    recorder.stop()
    expect(VOICE_NOTE_SEGMENT_MS).toBe(300_000)
    expect(segments.map((s) => Math.round(s.durationMs / 1000))).toEqual([300, 300, 120])
    expect(segments.map((s) => Math.round(s.startMs / 1000))).toEqual([0, 300, 600])
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2])
  })

  it('静音的段有声时长为 0(不会送去转写)', async () => {
    const { backend, state } = fakeBackend()
    const recorder = new PhoneVoiceRecorder(backend)
    const { segments, handlers } = collect()
    await recorder.start(handlers)
    for (let i = 0; i < 20; i += 1) state.onFrame(frame(1_600, 0))
    expect(recorder.getSnapshot().silentMs).toBeGreaterThan(1_000)
    recorder.stop()
    expect(segments[0]!.voicedMs).toBe(0)
  })

  it('麦克风半路没了:已录的照常交出去,标记 interrupted 并留下原因', async () => {
    const { backend, state } = fakeBackend()
    const recorder = new PhoneVoiceRecorder(backend)
    const { segments, ends, handlers } = collect()
    await recorder.start(handlers)
    state.onFrame(frame(16_000))
    state.onEnded()
    expect(segments).toHaveLength(1)
    expect(ends[0]).toMatchObject({ interrupted: true })
    expect(recorder.getSnapshot().error).toBe('interrupted')
    expect(recorder.busy).toBe(false)
  })

  it('还在「正在开始」时取消:麦克风还回去,不交任何东西', async () => {
    let release: () => void = () => undefined
    const { backend, state } = fakeBackend({ open: () => new Promise<void>((resolve) => void (release = resolve)) })
    const recorder = new PhoneVoiceRecorder(backend)
    const { segments, ends, handlers } = collect()
    const starting = recorder.start(handlers)
    expect(recorder.getSnapshot().phase).toBe('starting')
    recorder.cancel()
    release()
    await expect(starting).resolves.toBe(false)
    expect(state.stopped).toBe(1)
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'idle', error: null })
    expect(segments).toEqual([])
    expect(ends).toEqual([])
  })

  it('同时只录一条', async () => {
    const { backend, state } = fakeBackend()
    const recorder = new PhoneVoiceRecorder(backend)
    await recorder.start(collect().handlers)
    await expect(recorder.start(collect().handlers)).resolves.toBe(false)
    expect(state.opened).toBe(1)
  })
})

describe('webAudioBackend:真麦克风那一层(WebView 的 getUserMedia + AudioContext 换成假的)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 假的 AudioContext:没有 audioWorklet,逼出 ScriptProcessor 那条路。 */
  function stubAudioContext() {
    const processor: { onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null; connect: () => void; disconnect: () => void } = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    const closed = vi.fn(async () => undefined)
    class FakeContext {
      state = 'running'
      sampleRate = 16_000
      destination = {}
      audioWorklet = undefined
      addEventListener = vi.fn()
      resume = vi.fn(async () => undefined)
      close = closed
      createScriptProcessor = () => processor
      createMediaStreamSource = () => ({ connect: vi.fn() })
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
    }
    vi.stubGlobal('AudioContext', FakeContext)
    return { processor, closed }
  }

  it('系统没给麦克风:getUserMedia 被拒(NotAllowedError)→ 开不起来,原因 mic_denied,上下文还回去', async () => {
    const { closed } = stubAudioContext()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')) } })
    await expect(webAudioBackend.open(() => undefined, () => undefined)).rejects.toMatchObject({ name: 'MicOpenError', failure: 'mic_denied' })
    expect(closed).toHaveBeenCalled()
  })

  it('没有 mediaDevices(不安全上下文 / 老 WebView):开不起来,原因 capture_failed', async () => {
    vi.stubGlobal('navigator', {})
    await expect(webAudioBackend.open(() => undefined, () => undefined)).rejects.toMatchObject({ failure: 'capture_failed' })
  })

  it('开起来:帧经 ScriptProcessor 推出来(没有 audioWorklet 时),采样率按上下文报,stop 把麦克风与上下文还回去', async () => {
    const { processor, closed } = stubAudioContext()
    const track = { stop: vi.fn(), addEventListener: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } })
    const frames: Float32Array[] = []
    const session = await webAudioBackend.open((frame) => frames.push(frame), () => undefined)
    expect(session.sampleRate).toBe(16_000)
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from([0.1, 0.2]) } })
    expect(frames).toHaveLength(1)
    expect([...frames[0]!].map((v) => Math.round(v * 10))).toEqual([1, 2])
    session.stop()
    expect(track.stop).toHaveBeenCalled()
    expect(closed).toHaveBeenCalled()
    expect(processor.disconnect).toHaveBeenCalled()
  })
})
