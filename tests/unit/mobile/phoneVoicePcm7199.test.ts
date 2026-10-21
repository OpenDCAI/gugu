import { describe, expect, it } from 'vitest'
import { VOICE_NOTE_SEGMENT_MS } from '@gugu/core/shared/voiceNotes'
import { Downsampler, levelOf, PcmSegmenter, rmsOf, VOICE_NOTE_SAMPLE_RATE, wavHeader, type PcmSegment } from '../../../apps/desktop/src/mobile/assistant/phoneVoicePcm'

// #7199 手机录语音笔记的 PCM 这一层:任意采样率的帧 → 16k 单声道 16 位,每 5 分钟一段 WAV(与桌面送去转写的格式同一个)。

function tone(samples: number, amplitude: number, value?: number): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i += 1) out[i] = value ?? amplitude * Math.sin((2 * Math.PI * 440 * i) / 48_000)
  return out
}

describe('Downsampler', () => {
  it('48k → 16k:每 3 个样本出 1 个,常数信号原样保持', () => {
    const down = new Downsampler(48_000)
    const out = down.push(tone(4800, 0, 0.5))
    expect(out.length).toBe(1600)
    expect(Math.max(...out)).toBeCloseTo(0.5, 6)
    expect(Math.min(...out)).toBeCloseTo(0.5, 6)
  })

  it('同采样率原样通过', () => {
    const down = new Downsampler(16_000)
    const input = Float32Array.from([0.1, -0.2, 0.3])
    expect([...down.push(input)]).toEqual([...input].map((v) => Math.fround(v)))
  })

  it('帧怎么切结果都一样(窗口跨帧接得上),总数按比例', () => {
    const signal = tone(44_100, 0.8)
    const whole = new Downsampler(44_100).push(signal)
    const split = new Downsampler(44_100)
    const parts: number[] = []
    for (let at = 0; at < signal.length; ) {
      const size = 1 + ((at * 7) % 997)
      parts.push(...split.push(signal.subarray(at, at + size)))
      at += size
    }
    expect(parts.length).toBe(whole.length)
    expect(whole.length).toBe(16_000)
    for (let i = 0; i < whole.length; i += 1) expect(parts[i]).toBeCloseTo(whole[i]!, 5)
  })
})

describe('读数', () => {
  it('rms / 波形条高度:静音 0,越响越高,封顶 1', () => {
    expect(rmsOf(new Float32Array(10))).toBe(0)
    expect(rmsOf(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5, 6)
    expect(levelOf(0)).toBe(0)
    expect(levelOf(0.001)).toBeLessThan(levelOf(0.1))
    expect(levelOf(10)).toBe(1)
  })
})

describe('wavHeader', () => {
  it('单声道 16 位 16k:RIFF / WAVE / 采样率 / 数据长度', () => {
    const view = new DataView(wavHeader(16_000).buffer)
    const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, n))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(32_000)
    expect(view.getUint32(4, true)).toBe(36 + 32_000)
  })
})

describe('PcmSegmenter:按核心格式切段', () => {
  it('核心定的段长是 5 分钟', () => {
    expect(VOICE_NOTE_SEGMENT_MS).toBe(5 * 60_000)
  })

  it('每 segmentMs 一段,最后一段 cut 交出去;起点 / 时长按样本数算', () => {
    const segments: PcmSegment[] = []
    const segmenter = new PcmSegmenter(48_000, (s) => segments.push(s), 1_000)
    // 2.5 秒,每帧 2048 样本(安卓 worklet 的包大小)。
    const total = 48_000 * 2.5
    for (let sent = 0; sent < total; sent += 2048) segmenter.push(tone(Math.min(2048, total - sent), 0.5))
    segmenter.cut()
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2])
    expect(segments[0]!.startMs).toBe(0)
    expect(segments[0]!.durationMs).toBeGreaterThanOrEqual(1_000)
    expect(segments[0]!.durationMs).toBeLessThan(1_100)
    expect(segments[1]!.startMs).toBeCloseTo(segments[0]!.durationMs, 6)
    expect(segments[2]!.startMs).toBeCloseTo(segments[0]!.durationMs + segments[1]!.durationMs, 6)
    const sum = segments.reduce((n, s) => n + s.durationMs, 0)
    expect(sum).toBeCloseTo(2_500, -1)
    expect(segmenter.meter.elapsedMs).toBeCloseTo(sum, 6)
  })

  it('每段是自己能解的 WAV:头里的数据长度 = 实际字节', async () => {
    const segments: PcmSegment[] = []
    const segmenter = new PcmSegmenter(16_000, (s) => segments.push(s), 500)
    segmenter.push(tone(8_000, 0.5))
    segmenter.cut()
    const bytes = new Uint8Array(await segments[0]!.wav.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(segments[0]!.wav.type).toBe('audio/wav')
    expect(view.getUint32(24, true)).toBe(VOICE_NOTE_SAMPLE_RATE)
    expect(view.getUint32(40, true)).toBe(bytes.length - 44)
    expect(bytes.length - 44).toBe(8_000 * 2)
  })

  it('有声时长只算响的帧;静音的不算,连续静音计时遇到声音归零', () => {
    const segments: PcmSegment[] = []
    const segmenter = new PcmSegmenter(16_000, (s) => segments.push(s), 60_000)
    for (let i = 0; i < 10; i += 1) segmenter.push(tone(1_600, 0, 0))
    expect(segmenter.meter.silentMs).toBeCloseTo(1_000, 6)
    for (let i = 0; i < 5; i += 1) segmenter.push(tone(1_600, 0, 0.3))
    expect(segmenter.meter.silentMs).toBe(0)
    segmenter.cut()
    expect(segments[0]!.voicedMs).toBeCloseTo(500, 6)
    expect(segments[0]!.durationMs).toBeCloseTo(1_500, 6)
  })

  it('什么都没收到 cut 不出空段', () => {
    const segments: PcmSegment[] = []
    new PcmSegmenter(48_000, (s) => segments.push(s), 1_000).cut()
    expect(segments).toEqual([])
  })
})
